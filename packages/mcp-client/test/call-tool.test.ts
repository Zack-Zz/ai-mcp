import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError as SdkMcpError } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '../src/client.js';

type ToolSpec = {
  name: string;
  outputSchema?: unknown;
  meta?: Record<string, unknown>;
  handler: (request: {
    params?: { name?: string; arguments?: Record<string, unknown> | undefined } | undefined;
  }) => unknown;
};

function startToolServer(tools: ToolSpec[]) {
  const server = new Server(
    { name: 'fake-tools', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  const calls: { name: string; arguments: unknown }[] = [];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.name,
      inputSchema: { type: 'object', properties: {}, additionalProperties: true },
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.meta !== undefined ? { _meta: tool.meta } : {})
    }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (rawRequest) => {
    const request = rawRequest as {
      params?: { name?: string; arguments?: Record<string, unknown> | undefined } | undefined;
    };
    const name = request.params?.name ?? '';
    const args = request.params?.arguments ?? {};
    calls.push({ name, arguments: args });
    const tool = tools.find((item) => item.name === name);
    if (!tool) {
      throw new SdkMcpError(-32602, `Unknown tool: ${name}`);
    }
    return tool.handler(request) as never;
  });

  return { server, calls };
}

async function connectClient(server: Server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient(clientTransport, 2000);
  await client.connect();
  return client;
}

describe('callToolResult / callValidatedTool', () => {
  it('uses one call budget across discovery pages before tool execution', async () => {
    let calls = 0;
    const server = new Server({ name: 'budget', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return request.params?.cursor
        ? { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] }
        : { tools: [], nextCursor: 'second' };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      calls++;
      return { content: [], structuredContent: { done: true } };
    });
    const client = await connectClient(server);
    try {
      await expect(client.callToolResult('probe', {}, { timeoutMs: 60 })).rejects.toMatchObject({
        category: 'backend_timeout'
      });
      expect(calls).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('calls dynamic tool names without ToolName assertions and returns native results', async () => {
    const { server } = startToolServer([
      {
        name: 'catalog.lookup',
        outputSchema: {
          type: 'object',
          properties: { sku: { type: 'string' } },
          required: ['sku']
        },
        handler: ({ params }) => ({
          content: [{ type: 'text', text: JSON.stringify({ sku: params?.arguments?.sku }) }],
          structuredContent: { sku: params?.arguments?.sku },
          isError: false
        })
      }
    ]);
    const client = await connectClient(server);

    const result = await client.callToolResult('catalog.lookup', { sku: 'sku-1' });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ sku: 'sku-1' });

    const validated = await client.callValidatedTool(
      'catalog.lookup',
      { sku: 'sku-2' },
      z.object({ sku: z.string() })
    );
    expect(validated).toEqual({ sku: 'sku-2' });

    await client.close();
    await server.close();
  });

  it('keeps isError failures with structured error payloads instead of throwing schema errors', async () => {
    const { server } = startToolServer([
      {
        name: 'warehouse.reserve',
        // success schema requires {reservationId}; the error payload violates it
        outputSchema: {
          type: 'object',
          properties: { reservationId: { type: 'string' } },
          required: ['reservationId'],
          additionalProperties: false
        },
        handler: () => ({
          content: [{ type: 'text', text: JSON.stringify({ reason: 'out_of_stock' }) }],
          structuredContent: { reason: 'out_of_stock', retryable: false },
          isError: true
        })
      }
    ]);
    const client = await connectClient(server);

    const result = await client.callToolResult('warehouse.reserve', {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ reason: 'out_of_stock', retryable: false });

    await expect(
      client.callValidatedTool('warehouse.reserve', {}, z.object({ reservationId: z.string() }))
    ).rejects.toThrowError(/out_of_stock|warehouse.reserve|tool/i);

    await client.close();
    await server.close();
  });

  it('decodes text JSON fallback when no structured content exists', async () => {
    const { server } = startToolServer([
      {
        name: 'legacy.json',
        handler: () => ({
          content: [{ type: 'text', text: '{"value": 42}' }],
          isError: false
        })
      }
    ]);
    const client = await connectClient(server);

    const decoded = await client.callValidatedTool(
      'legacy.json',
      {},
      z.object({ value: z.number() })
    );
    expect(decoded).toEqual({ value: 42 });

    await client.close();
    await server.close();
  });

  it('rejects plain text results that do not parse as the expected output', async () => {
    const { server } = startToolServer([
      {
        name: 'plain.text',
        handler: () => ({ content: [{ type: 'text', text: 'just text' }], isError: false })
      }
    ]);
    const client = await connectClient(server);

    await expect(
      client.callValidatedTool('plain.text', {}, z.object({ value: z.number() }))
    ).rejects.toThrowError(/plain.text|text|parse/i);

    await client.close();
    await server.close();
  });

  it('preserves image, audio and resource content blocks', async () => {
    const { server } = startToolServer([
      {
        name: 'media.snapshot',
        handler: () => ({
          content: [
            { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
            { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav' },
            {
              type: 'resource',
              resource: { uri: 'file:///report.pdf', mimeType: 'application/pdf', blob: 'cnBkZg==' }
            }
          ],
          isError: false
        })
      }
    ]);
    const client = await connectClient(server);

    const result = await client.callToolResult('media.snapshot', {});
    expect(result.isError).toBe(false);
    expect(result.content.map((block) => block.type)).toEqual(['image', 'audio', 'resource']);

    await client.close();
    await server.close();
  });

  it('validates input against the discovered schema before hitting the wire', async () => {
    const server = new Server(
      { name: 'strict', version: '0.0.1' },
      { capabilities: { tools: {} } }
    );
    const calls: unknown[] = [];
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'orders.create',
          description: 'orders',
          inputSchema: {
            type: 'object',
            properties: { quantity: { type: 'number' } },
            required: ['quantity'],
            additionalProperties: false
          }
        }
      ]
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params);
      return { content: [{ type: 'text', text: 'created' }], isError: false } as never;
    });
    const client = await connectClient(server);
    await client.discoverTools();

    await expect(client.callToolResult('orders.create', { quantity: 'many' })).rejects.toThrowError(
      /input|quantity/i
    );
    await expect(client.callToolResult('orders.create', { extra: 1 })).rejects.toThrowError(
      /input|extra|quantity/i
    );
    expect(calls).toHaveLength(0);

    await client.close();
    await server.close();
  });

  it('reports invalid_result when a declared output schema is violated by the success payload', async () => {
    const { server } = startToolServer([
      {
        name: 'liar.tool',
        outputSchema: {
          type: 'object',
          properties: { expected: { type: 'string' } },
          required: ['expected'],
          additionalProperties: false
        },
        handler: () => ({
          content: [{ type: 'text', text: JSON.stringify({ wrong: true }) }],
          structuredContent: { wrong: true },
          isError: false
        })
      }
    ]);
    const client = await connectClient(server);

    await expect(client.callToolResult('liar.tool', {})).rejects.toThrowError(
      /invalid result|output schema|liar.tool/i
    );

    await client.close();
    await server.close();
  });

  it('reports invalid_result when structured content is missing despite a declared output schema', async () => {
    const { server } = startToolServer([
      {
        name: 'missing.sc',
        outputSchema: {
          type: 'object',
          properties: { expected: { type: 'string' } },
          required: ['expected']
        },
        handler: () => ({
          content: [{ type: 'text', text: 'no structured content' }],
          isError: false
        })
      }
    ]);
    const client = await connectClient(server);

    await expect(client.callToolResult('missing.sc', {})).rejects.toThrowError(
      /invalid result|structured/i
    );

    await client.close();
    await server.close();
  });

  it('classifies unknown-tool JSON-RPC errors without swallowing them', async () => {
    const { server } = startToolServer([]);
    const client = await connectClient(server);

    await expect(client.callToolResult('missing.tool', {})).rejects.toThrowError(
      /unknown|missing/i
    );

    await client.close();
    await server.close();
  });
});

describe('standard/v1 descriptors through the generic client', () => {
  it('rejects a malformed standard success instead of bypassing the declared schema', async () => {
    const { server } = startToolServer([
      {
        name: 'invalid.standard',
        meta: { 'org.ai-mcp/result-contract': 'standard/v1' },
        outputSchema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            code: { type: 'string' },
            message: { type: 'string' }
          },
          required: ['ok', 'code', 'message']
        },
        handler: () => ({ content: [], structuredContent: { ok: true, code: 7, message: 'done' } })
      }
    ]);
    const client = await connectClient(server);
    try {
      await expect(client.callToolResult('invalid.standard', {})).rejects.toMatchObject({
        category: 'invalid_result'
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('returns ok:false envelopes as native results instead of schema errors', async () => {
    const { server } = startToolServer([
      {
        name: 'report.status',
        outputSchema: {
          type: 'object',
          properties: { done: { type: 'boolean' } },
          required: ['done'],
          additionalProperties: false
        },
        meta: { 'org.ai-mcp/result-contract': 'standard/v1' },
        handler: () => ({
          content: [{ type: 'text', text: 'report' }],
          structuredContent: { ok: false, code: 'REPORT_REJECTED', message: 'window closed' },
          isError: false
        })
      }
    ]);
    const client = await connectClient(server);
    await client.discoverTools();

    const result = await client.callToolResult('report.status', {});
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: 'REPORT_REJECTED' });

    await client.close();
    await server.close();
  });
});
