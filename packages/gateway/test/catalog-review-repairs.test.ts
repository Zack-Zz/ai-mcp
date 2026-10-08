import { expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { SchemaCompiler, type NativeToolResult, type ToolDescriptor } from '@ai-mcp/shared';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '@ai-mcp/mcp-client';
import { buildCatalogEntries } from '../src/tool-catalog.js';
import { McpGatewayCore } from '../src/gateway-core.js';
import { McpGatewayServer } from '../src/gateway-server.js';
import { adaptDownstreamResult } from '../src/result-adapter.js';
import type { CallContextOptions, DownstreamConnector } from '../src/connectors/base.js';

const tool: ToolDescriptor = {
  name: 'lookup',
  inputSchema: { type: 'object' },
  _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
};
function catalog(descriptor: ToolDescriptor = tool) {
  return buildCatalogEntries({ backends: [{ id: 'b', tools: [descriptor] }] });
}

it('advertises the actual standard envelope and preserves the source contract separately', () => {
  const entry = catalog().entries[0];
  expect(entry?.contract).toBe('native-json/v1');
  expect(entry?.advertised._meta?.['org.ai-mcp/result-contract']).toBe('standard/v1');
  expect(entry?.advertised._meta?.['org.ai-mcp/downstream-tool']).toMatchObject({
    resultContract: 'native-json/v1'
  });
  expect(entry?.source._meta?.['org.ai-mcp/result-contract']).toBe('native-json/v1');
});

it('publishes the unmodified source descriptor alongside the effective and public contracts', () => {
  const source: ToolDescriptor = {
    ...tool,
    outputSchema: { $id: 'https://peer.test/original', type: 'object' },
    annotations: { readOnlyHint: true },
    _meta: {
      custom: 'retained',
      'org.ai-mcp/result-contract': 'standard/v1',
      'org.ai-mcp/downstream-tool': { backendId: 'previous', toolName: 'original' }
    }
  };
  const entry = buildCatalogEntries({
    backends: [{ id: 'b', resultContract: 'native-json/v1', tools: [source] }]
  }).entries[0];
  expect(entry?.advertised._meta?.['org.ai-mcp/result-contract']).toBe('standard/v1');
  expect(entry?.advertised._meta?.['org.ai-mcp/downstream-tool']).toMatchObject({
    resultContract: 'native-json/v1',
    descriptor: source
  });
  expect(source._meta?.['org.ai-mcp/result-contract']).toBe('standard/v1');
});

it('the public legacy-auto view accepts an old standard success without payload while rejecting empty native results', () => {
  const entry = buildCatalogEntries({
    backends: [{ id: 'b', tools: [{ name: 'legacy', inputSchema: { type: 'object' } }] }]
  }).entries[0];
  if (!entry) throw new Error('missing entry');
  const result = adaptDownstreamResult(
    {
      content: [{ type: 'text', text: '{"ok":true,"code":"OK","message":"acknowledged"}' }],
      isError: false
    },
    entry
  );
  expect(result.kind).toBe('success');
  if (result.kind !== 'success') throw new Error('expected success');
  expect(entry.publicOutputValidator.validate(result.standard).valid).toBe(true);
  expect(adaptDownstreamResult({ content: [], isError: false }, entry).kind).toBe('failure');
});

it.each(['backend bad/slash', '', 'x'.repeat(129)])(
  'rejects invalid backend identity %s before publishing any directory',
  (id) => {
    expect(() => buildCatalogEntries({ backends: [{ id, tools: [] }] })).toThrow(
      /backend|identity/i
    );
  }
);

it('rejects a mapped name exceeding the shared limit instead of publishing an undiscoverable tool', () => {
  expect(() => catalog({ ...tool, name: 'x'.repeat(128) })).toThrow(/mapped|public|name/i);
});

it('honors explicit legacy-auto over a downstream native declaration', () => {
  const entry = buildCatalogEntries({
    backends: [{ id: 'b', resultContract: 'legacy-auto', tools: [tool] }]
  }).entries[0];
  if (!entry) throw new Error('missing entry');
  expect(entry.contract).toBe('legacy-auto');
  expect(
    adaptDownstreamResult(
      {
        content: [],
        structuredContent: { ok: false, code: 'DENIED', message: 'denied' },
        isError: false
      },
      entry
    ).kind
  ).toBe('tool_failure');
});

it('reports an unusable public schema as a catalog descriptor error', () => {
  expect(() =>
    catalog({ ...tool, outputSchema: { type: 'object', $anchor: 'unrelocatable' } })
  ).toThrow(expect.objectContaining({ code: 'INVALID_DESCRIPTOR' }));
});

it.each(['input', 'standard output'])(
  'rejects a non-object MCP %s schema before serving a directory',
  (part) => {
    const descriptor: ToolDescriptor =
      part === 'input'
        ? { ...tool, inputSchema: { type: 'string' } }
        : {
            ...tool,
            _meta: { 'org.ai-mcp/result-contract': 'standard/v1' },
            outputSchema: { type: 'string' }
          };
    expect(() => catalog(descriptor)).toThrow(
      expect.objectContaining({ code: 'INVALID_DESCRIPTOR' })
    );
  }
);

it('Core applies the effective contract to both invocation and its public compatibility output', async () => {
  let received: CallContextOptions | undefined;
  const payload = { ok: false, code: 'FAILED_TASK', message: 'query succeeded' };
  const connector: DownstreamConnector = {
    listTools: async () => [{ name: tool.name, description: '', descriptor: tool }],
    callTool: async (_name, _args, _signal, context) => {
      received = context;
      return {
        durationMs: 0,
        native: { content: [], structuredContent: payload, isError: false },
        output: payload
      };
    },
    close: async () => undefined
  };
  const core = new McpGatewayCore(
    [{ id: 'b', transport: 'http', endpoint: 'http://unused' }],
    () => connector
  );
  try {
    await core.refreshTools();
    const result = await core.callMappedTool('b__lookup', {}, undefined, { traceId: 'trace' });
    expect(received).toMatchObject({ traceId: 'trace', resultContract: 'native-json/v1' });
    expect(result.output).toMatchObject({ ok: true, structuredContent: payload });
    expect(result.native.isError).toBe(false);
  } finally {
    await core.close();
  }
});

it('two real HTTP Gateways return a single envelope and a matching published schema', async () => {
  const native: NativeToolResult = {
    content: [{ type: 'text', text: 'catalog narrative' }],
    structuredContent: { sku: 'sku-1' },
    isError: false
  };
  const descriptor = {
    ...tool,
    outputSchema: {
      type: 'object',
      properties: { sku: { type: 'string' } },
      required: ['sku'],
      additionalProperties: false
    }
  };
  const connector: DownstreamConnector = {
    listTools: async () => [{ name: tool.name, description: '', descriptor }],
    callTool: async () => ({
      durationMs: 0,
      native,
      output: { ok: true, code: 'OK', message: 'done' }
    }),
    close: async () => undefined
  };
  const inner = new McpGatewayServer([{ id: 'b', transport: 'http', endpoint: 'http://unused' }], {
    connectorFactory: () => connector
  });
  await inner.initialize();
  const listener = inner.startHttp({ port: 0 });
  await once(listener, 'listening');
  const outer = new McpGatewayServer([
    {
      id: 'g',
      transport: 'http',
      endpoint: `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`
    }
  ]);
  let client: McpClient | undefined;
  try {
    await outer.initialize();
    const upstream = outer.startHttp({ port: 0 });
    await once(upstream, 'listening');
    client = new McpClient(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`)
      ) as unknown as ConstructorParameters<typeof McpClient>[0]
    );
    const descriptors = await client.discoverTools();
    const result = await client.callToolResult('g__b__lookup', {});
    expect(result.structuredContent).toMatchObject({
      ok: true,
      structuredContent: { sku: 'sku-1' }
    });
    expect(result.structuredContent).not.toMatchObject({ structuredContent: { ok: true } });
    expect(descriptors[0]?._meta?.['org.ai-mcp/result-contract']).toBe('standard/v1');
    expect(
      new SchemaCompiler().compile(descriptors[0]?.outputSchema).validate(result.structuredContent)
        .valid
    ).toBe(true);
  } finally {
    await client?.close();
    await outer.close();
    await inner.close();
  }
});

it.each(['backend', 'tool'])(
  'a real HTTP %s override replaces the peer declaration while retaining output validation',
  async (mode) => {
    let executed = 0;
    const instances = new Set<Server>();
    const downstream = createHttpServer(async (req, res) => {
      const peer = new Server(
        { name: 'misdeclared', version: '1' },
        { capabilities: { tools: {} } }
      );
      peer.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'lookup',
            inputSchema: { type: 'object' },
            outputSchema: {
              type: 'object',
              properties: { sku: { type: 'string' } },
              required: ['sku'],
              additionalProperties: false
            },
            _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
          }
        ]
      }));
      peer.setRequestHandler(CallToolRequestSchema, async (request) => {
        executed++;
        return {
          content: [],
          structuredContent: { sku: request.params.arguments?.invalid ? 7 : 'sku-1' }
        };
      });
      const transport = new StreamableHTTPServerTransport({});
      instances.add(peer);
      res.once('close', () => {
        void peer.close().finally(() => instances.delete(peer));
      });
      await peer.connect(transport as unknown as Parameters<Server['connect']>[0]);
      await transport.handleRequest(req, res);
    });
    downstream.listen(0);
    await once(downstream, 'listening');
    const gateway = new McpGatewayServer(
      [
        {
          id: 'b',
          transport: 'http',
          endpoint: `http://127.0.0.1:${(downstream.address() as AddressInfo).port}/mcp`,
          ...(mode === 'backend' ? { resultContract: 'native-json/v1' as const } : {})
        }
      ],
      mode === 'tool' ? { resultContracts: { toolOverrides: { b__lookup: 'native-json/v1' } } } : {}
    );
    const client = new Client({ name: 'override', version: '1' });
    try {
      await gateway.initialize();
      const [a, b] = InMemoryTransport.createLinkedPair();
      await gateway.connect(b);
      await client.connect(a);
      const result = await client.callTool({ name: 'b__lookup', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({
        ok: true,
        structuredContent: { sku: 'sku-1' }
      });
      await expect(
        client.callTool({ name: 'b__lookup', arguments: { invalid: true } })
      ).rejects.toMatchObject({ data: { category: 'invalid_result' } });
      expect(executed).toBe(2);
    } finally {
      await client.close();
      await gateway.close();
      await Promise.all([...instances].map((peer) => peer.close()));
      downstream.closeAllConnections();
      await new Promise<void>((resolve) => downstream.close(() => resolve()));
    }
  }
);
