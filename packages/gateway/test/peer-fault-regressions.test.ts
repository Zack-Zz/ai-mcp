import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult
} from '@modelcontextprotocol/sdk/types.js';
import { CONTEXT_META_KEY, closeHttpListener, type InvocationFault } from '@ai-mcp/shared';
import { McpClient } from '@ai-mcp/mcp-client';
import { McpGatewayServer } from '../src/gateway-server.js';
import { HttpConnector } from '../src/connectors/http.js';
import { StdioConnector } from '../src/connectors/stdio.js';

const descriptor = {
  name: 'probe',
  inputSchema: { type: 'object' as const },
  _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
};

async function startPeer(kind: 'http' | 'stdio', call: () => Promise<CallToolResult>) {
  const server = new Server({ name: 'peer-fault', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [descriptor] }));
  server.setRequestHandler(CallToolRequestSchema, call);
  if (kind === 'stdio') {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    return {
      connector: new StdioConnector({
        command: 'unused',
        timeoutMs: 1000,
        clientFactory: () => new McpClient(clientTransport)
      }),
      close: () => server.close()
    };
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true
  });
  await server.connect(transport as unknown as Transport);
  const listener = createServer((request, response) => {
    void transport.handleRequest(request, response);
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const endpoint = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`;
  return {
    connector: new HttpConnector(endpoint, 1000),
    close: async () => {
      await server.close();
      await closeHttpListener(listener, 1000);
    }
  };
}

async function connectUpstream(gateway: McpGatewayServer) {
  await gateway.initialize();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverTransport);
  const client = new Client({ name: 'peer-fault-upstream', version: '1' });
  await client.connect(clientTransport);
  return client;
}

async function captureFault(client: Client, name = 'peer__probe') {
  try {
    await client.callTool({
      name,
      arguments: {},
      _meta: { [CONTEXT_META_KEY]: { traceId: 'local-trace' } }
    });
  } catch (error) {
    expect(error).toBeInstanceOf(McpError);
    return (error as McpError).data as Record<string, unknown>;
  }
  throw new Error('Expected peer fault');
}

const fault: InvocationFault = {
  category: 'invalid_result',
  projectCode: 'PEER_OUTPUT_INVALID',
  message: 'Peer output validation failed',
  traceId: 'peer-trace',
  invocationId: 'peer-invocation',
  executionDisposition: 'completed',
  source: { kind: 'peer', backendId: 'origin', traceId: 'origin-trace', code: 42 },
  details: { validator: 'peer-output' }
};

describe.each(['http', 'stdio'] as const)('real SDK peer faults through %s connector', (kind) => {
  it.each([
    ['invalid_request', 'not_started'],
    ['invalid_params', 'not_started'],
    ['tool_failure', 'completed'],
    ['invalid_result', 'completed'],
    ['policy_denied', 'not_started'],
    ['rate_limited', 'not_started'],
    ['unsupported_capability', 'not_started'],
    ['audit_unavailable', 'completed'],
    ['cancelled', 'unknown'],
    ['backend_timeout', 'unknown'],
    ['backend_unavailable', 'unknown'],
    ['internal', 'unknown']
  ] as const)(
    'preserves %s with %s execution and local identity',
    async (category, disposition) => {
      let calls = 0;
      const payload = {
        ...fault,
        category,
        executionDisposition: disposition,
        operationCompleted:
          disposition === 'completed' ? true : disposition === 'not_started' ? false : null
      };
      const peer = await startPeer(kind, async () => {
        calls++;
        throw new McpError(-32603, payload.message, payload);
      });
      const gateway = new McpGatewayServer(
        [{ id: 'peer', transport: 'http', endpoint: 'http://unused' }],
        { connectorFactory: () => peer.connector }
      );
      let client: Client | undefined;
      try {
        client = await connectUpstream(gateway);
        const data = await captureFault(client);
        expect(data).toMatchObject({
          ...payload,
          traceId: 'local-trace',
          invocationId: expect.any(String),
          details: { ...payload.details, peerFault: payload }
        });
        expect(data.invocationId).toBeTruthy();
        expect(data.invocationId).not.toBe('peer-invocation');
        expect(gateway.getInMemoryAuditEvents().at(-1)).toMatchObject({
          traceId: 'local-trace',
          invocationId: data.invocationId,
          errorCategory: category,
          resultCode: payload.projectCode,
          executionDisposition: disposition,
          downstreamTraceId: 'origin-trace'
        });
        expect(calls).toBe(1);
      } finally {
        await client?.close();
        await gateway.close();
        await peer.close();
      }
    }
  );

  it('correlates the peer trace when the valid fault carries no source', async () => {
    const payload = { ...fault, source: undefined };
    const peer = await startPeer(kind, async () => {
      throw new McpError(-32603, payload.message, payload);
    });
    const gateway = new McpGatewayServer(
      [{ id: 'peer', transport: 'http', endpoint: 'http://unused' }],
      { connectorFactory: () => peer.connector }
    );
    let client: Client | undefined;
    try {
      client = await connectUpstream(gateway);
      expect(await captureFault(client)).toMatchObject({
        traceId: 'local-trace',
        source: { kind: 'peer', backendId: 'peer', traceId: 'peer-trace' }
      });
      expect(gateway.getInMemoryAuditEvents().at(-1)?.downstreamTraceId).toBe('peer-trace');
    } finally {
      await client?.close();
      await gateway.close();
      await peer.close();
    }
  });
});

it('retains source metadata and uses the immediate peer trace when source has none', async () => {
  const payload = { ...fault, source: { kind: 'sdk' as const, code: -32603 } };
  const peer = await startPeer('http', async () => {
    throw new McpError(-32603, payload.message, payload);
  });
  const gateway = new McpGatewayServer(
    [{ id: 'peer', transport: 'http', endpoint: 'http://unused' }],
    { connectorFactory: () => peer.connector }
  );
  let client: Client | undefined;
  try {
    client = await connectUpstream(gateway);
    expect(await captureFault(client)).toMatchObject({
      source: { ...payload.source, traceId: payload.traceId },
      details: { peerFault: payload }
    });
    expect(gateway.getInMemoryAuditEvents().at(-1)?.downstreamTraceId).toBe(payload.traceId);
  } finally {
    await client?.close();
    await gateway.close();
    await peer.close();
  }
});

it.each([
  { ...fault, executionDisposition: 'started' },
  { ...fault, category: 'unknown_peer_category' },
  { ...fault, invocationId: '' },
  { ...fault, source: { kind: 'unrecognized' } },
  { ...fault, operationCompleted: 'true' },
  { ...fault, operationCompleted: false },
  { ...fault, operationCompleted: null },
  {
    category: 'invalid_result',
    projectCode: 'PEER_OUTPUT_INVALID',
    executionDisposition: 'completed'
  }
])('keeps malformed peer execution data conservative: %j', async (payload) => {
  const peer = await startPeer('http', async () => {
    throw new McpError(-32603, 'Malformed peer fault', payload);
  });
  const gateway = new McpGatewayServer(
    [{ id: 'peer', transport: 'http', endpoint: 'http://unused' }],
    { connectorFactory: () => peer.connector }
  );
  let client: Client | undefined;
  try {
    client = await connectUpstream(gateway);
    const data = await captureFault(client);
    expect(data.executionDisposition).toBe('unknown');
    expect(data.operationCompleted).toBeUndefined();
    expect(data.source).toBeUndefined();
    expect(gateway.getInMemoryAuditEvents().at(-1)?.executionDisposition).toBe('unknown');
  } finally {
    await client?.close();
    await gateway.close();
    await peer.close();
  }
});

it('a nested real HTTP gateway preserves audit failure after one completed business operation', async () => {
  let executions = 0;
  const leaf = await startPeer('http', async () => {
    executions++;
    return { content: [], structuredContent: { done: true } };
  });
  const inner = new McpGatewayServer(
    [{ id: 'leaf', transport: 'http', endpoint: 'http://unused' }],
    {
      connectorFactory: () => leaf.connector,
      auditStore: {
        record: async () => {
          throw new Error('audit disk unavailable');
        }
      }
    }
  );
  await inner.initialize();
  const listener = inner.startHttp({ port: 0 });
  await once(listener, 'listening');
  const outer = new McpGatewayServer([
    {
      id: 'inner',
      transport: 'http',
      endpoint: `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`
    }
  ]);
  let client: Client | undefined;
  try {
    client = await connectUpstream(outer);
    const data = await captureFault(client, 'inner__leaf__probe');
    expect(data).toMatchObject({
      category: 'audit_unavailable',
      projectCode: 'AUDIT_UNAVAILABLE',
      traceId: 'local-trace',
      executionDisposition: 'completed',
      operationCompleted: true,
      source: { kind: 'audit', traceId: 'local-trace' }
    });
    expect(outer.getInMemoryAuditEvents().at(-1)).toMatchObject({
      invocationId: data.invocationId,
      outcome: 'protocol_error',
      errorCategory: 'audit_unavailable',
      resultCode: 'AUDIT_UNAVAILABLE',
      executionDisposition: 'completed',
      downstreamTraceId: 'local-trace'
    });
    expect(executions).toBe(1);
  } finally {
    await client?.close();
    await outer.close();
    await inner.close();
    await leaf.close();
  }
});

it('a real HTTP query of a failed task remains a successful query', async () => {
  const payload = {
    ok: false,
    code: 'FAILED_TASK',
    message: 'Task failed',
    task: { state: 'failed' }
  };
  const peer = await startPeer('http', async () => ({ content: [], structuredContent: payload }));
  const gateway = new McpGatewayServer(
    [{ id: 'peer', transport: 'http', endpoint: 'http://unused' }],
    { connectorFactory: () => peer.connector }
  );
  let client: Client | undefined;
  try {
    client = await connectUpstream(gateway);
    const result = await client.callTool({ name: 'peer__probe', arguments: {} });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ ok: true, structuredContent: payload });
    expect(gateway.getInMemoryAuditEvents().at(-1)?.outcome).toBe('success');
  } finally {
    await client?.close();
    await gateway.close();
    await peer.close();
  }
});
