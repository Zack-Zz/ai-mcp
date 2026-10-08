import { expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { createConnection, type AddressInfo, type Socket } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { CONTEXT_META_KEY } from '@ai-mcp/shared';
import { createServer } from '../../mcp-server/src/server.js';
import { McpGatewayServer } from '../src/gateway-server.js';
import { DownstreamConnectorError, type DownstreamConnector } from '../src/connectors/base.js';

const connector: DownstreamConnector = {
  async listTools() {
    return [
      {
        name: 'probe',
        description: '',
        descriptor: {
          name: 'probe',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' }
        }
      }
    ];
  },
  async callTool() {
    return {
      durationMs: 0,
      output: { ok: true, code: 'OK', message: '' },
      native: {
        isError: false,
        structuredContent: { done: true },
        content: [{ type: 'text', text: 'SUPPLEMENTARY_TEXT' }]
      }
    };
  },
  async close() {}
};

async function initialize(port: number): Promise<string> {
  const result = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'slow-body', version: '1' }
      }
    })
  });
  await result.text();
  const id = result.headers.get('mcp-session-id');
  if (!id) throw new Error('initialization omitted a session id');
  return id;
}

async function slowRequest(
  port: number,
  sessionId: string
): Promise<{ socket: Socket; response: Promise<string>; rest: string }> {
  const socket = createConnection({ host: '127.0.0.1', port });
  socket.on('error', () => undefined);
  await once(socket, 'connect');
  const body = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  let responseText = '';
  const response = new Promise<string>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      responseText += chunk.toString();
      if (responseText.includes('"result"') && responseText.includes('"id":2'))
        resolve(responseText);
    });
    socket.once('close', () => resolve(responseText));
  });
  socket.write(
    `POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nMcp-Session-Id: ${sessionId}\r\nConnection: close\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body[0]}`
  );
  return { socket, response, rest: body.slice(1) };
}

function slowAdmission(listener: HttpServer, sessionId: string): Promise<void> {
  return new Promise((resolve) => {
    const admitted = (req: IncomingMessage) => {
      if (req.method !== 'POST' || req.headers['mcp-session-id'] !== sessionId) return;
      listener.off('request', admitted);
      resolve();
    };
    listener.on('request', admitted);
  });
}

it.each(['server', 'gateway'] as const)(
  '%s DELETE cancels its incomplete body while another SDK session remains usable',
  async (kind) => {
    const owner = kind === 'server' ? createServer() : new McpGatewayServer([]);
    if (owner instanceof McpGatewayServer) await owner.initialize();
    const listener = owner.startHttp({ port: 0, sessionMode: 'stateful' });
    await once(listener, 'listening');
    const port = (listener.address() as AddressInfo).port;
    const sessionId = await initialize(port);
    const client = new Client({ name: 'independent-B', version: '1' });
    // SDK concrete transport exposes optional sessionId as string | undefined.
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${port}/mcp`)
      ) as unknown as Parameters<Client['connect']>[0]
    );
    const admitted = slowAdmission(listener, sessionId);
    const slow = await slowRequest(port, sessionId);
    await admitted;
    try {
      const deleted = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'DELETE',
        headers: { 'mcp-session-id': sessionId }
      });
      expect(deleted.status).toBe(200);
      expect(
        await Promise.race([
          slow.response,
          new Promise<string>((r) => setTimeout(() => r('hung'), 350))
        ])
      ).toMatch(/^HTTP\/1\.1 404/);
      expect((await client.listTools()).tools).toBeInstanceOf(Array);
    } finally {
      slow.socket.destroy();
      await client.close();
      await owner.close();
    }
  }
);

it.each(['server', 'gateway'] as const)(
  '%s TTL does not close a session that is reading an admitted request body',
  async (kind) => {
    const owner = kind === 'server' ? createServer() : new McpGatewayServer([]);
    if (owner instanceof McpGatewayServer) await owner.initialize();
    const listener = owner.startHttp({
      port: 0,
      sessionMode: 'stateful',
      sessionIdleTimeoutMs: 100
    });
    await once(listener, 'listening');
    const port = (listener.address() as AddressInfo).port;
    const id = await initialize(port);
    const admitted = slowAdmission(listener, id);
    const slow = await slowRequest(port, id);
    await admitted;
    try {
      await new Promise<void>((r) => setTimeout(r, 600));
      slow.socket.write(slow.rest);
      const result = await Promise.race([
        slow.response,
        new Promise<string>((r) => setTimeout(() => r('hung'), 350))
      ]);
      expect(result).toMatch(/^HTTP\/1\.1 200/);
      expect(result).toContain('"tools"');
    } finally {
      slow.socket.destroy();
      await owner.close();
    }
  }
);

it.each(['stateful', 'stateless'] as const)(
  '%s Gateway applies the same initialize body legacy-version policy',
  async (sessionMode) => {
    const gateway = new McpGatewayServer([]);
    await gateway.initialize();
    const listener = gateway.startHttp({ port: 0, sessionMode });
    await once(listener, 'listening');
    try {
      const denied = await fetch(
        `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream'
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'legacy', version: '1' }
            }
          })
        }
      );
      expect(denied.status).toBe(400);
    } finally {
      await gateway.close();
    }
  }
);

it.each(['stateful', 'stateless'] as const)(
  '%s Gateway audits the actual SDK negotiated protocol version',
  async (sessionMode) => {
    const gateway = new McpGatewayServer(
      [
        {
          id: 'local',
          transport: 'http',
          endpoint: 'http://down/mcp',
          resultContract: 'native-json/v1'
        }
      ],
      { connectorFactory: () => connector }
    );
    await gateway.initialize();
    const listener = gateway.startHttp({ port: 0, sessionMode });
    await once(listener, 'listening');
    const client = new Client({ name: 'audit-version', version: '1' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`)
    );
    await client.connect(transport as unknown as Parameters<Client['connect']>[0]);
    try {
      await client.callTool({ name: 'local__probe', arguments: {} });
      expect(gateway.getInMemoryAuditEvents().at(-1)?.protocolVersion).toBe('2025-11-25');
    } finally {
      if (sessionMode === 'stateful') await transport.terminateSession();
      await client.close();
      await gateway.close();
    }
  }
);

it('Gateway retains supplementary native text after its generated compatibility JSON text', async () => {
  const standardConnector: DownstreamConnector = {
    ...connector,
    async listTools() {
      return [
        {
          name: 'probe',
          description: '',
          descriptor: {
            name: 'probe',
            inputSchema: { type: 'object' },
            outputSchema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                code: { type: 'string' },
                message: { type: 'string' }
              },
              required: ['ok', 'code', 'message'],
              additionalProperties: false
            }
          }
        }
      ];
    },
    async callTool() {
      return {
        durationMs: 0,
        output: { ok: true, code: 'OK', message: 'closed envelope' },
        native: {
          isError: false,
          structuredContent: { ok: true, code: 'OK', message: 'closed envelope' },
          content: [{ type: 'text', text: 'SUPPLEMENTARY_TEXT' }]
        }
      };
    }
  };
  const gateway = new McpGatewayServer(
    [
      { id: 'local', transport: 'http', endpoint: 'http://down/mcp', resultContract: 'standard/v1' }
    ],
    { connectorFactory: () => standardConnector }
  );
  await gateway.initialize();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gateway.connect(b);
  const client = new Client({ name: 'content', version: '1' });
  await client.connect(a);
  try {
    const result = CallToolResultSchema.parse(
      await client.callTool({ name: 'local__probe', arguments: {} })
    );
    expect(result.content).toContainEqual({ type: 'text', text: 'SUPPLEMENTARY_TEXT' });
    expect(result.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('"ok":true')
    });
    expect(result.structuredContent).toEqual({ ok: true, code: 'OK', message: 'closed envelope' });
  } finally {
    await client.close();
    await gateway.close();
  }
});

it('Gateway observes initialize negotiation already queued when the transport starts', async () => {
  const gateway = new McpGatewayServer(
    [
      {
        id: 'local',
        transport: 'http',
        endpoint: 'http://down/mcp',
        resultContract: 'native-json/v1'
      }
    ],
    { connectorFactory: () => connector }
  );
  await gateway.initialize();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const originalStart = serverTransport.start.bind(serverTransport);
  const responses: unknown[] = [];
  clientTransport.onmessage = (message) => {
    responses.push(message);
  };
  serverTransport.start = async () => {
    await originalStart();
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2099-01-01',
        capabilities: {},
        clientInfo: { name: 'queued-stdio-peer', version: '1' }
      }
    });
    await new Promise<void>((r) => setImmediate(r));
  };
  try {
    await gateway.connect(serverTransport);
    expect(responses).toContainEqual(
      expect.objectContaining({
        result: expect.objectContaining({ protocolVersion: '2025-11-25' })
      })
    );
    await clientTransport.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'local__probe', arguments: {} }
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(gateway.getInMemoryAuditEvents().at(-1)?.protocolVersion).toBe('2025-11-25');
  } finally {
    await clientTransport.close();
    await gateway.close();
  }
});

it('Gateway preserves completed disposition and peer trace from a typed downstream result fault', async () => {
  const failing: DownstreamConnector = {
    ...connector,
    async callTool() {
      throw new DownstreamConnectorError('invalid_result', 'Invalid downstream output', {
        category: 'invalid_result',
        projectCode: 'INVALID_RESULT',
        message: 'Invalid downstream output',
        traceId: 'downstream-trace',
        invocationId: 'downstream-invocation',
        executionDisposition: 'completed',
        source: { kind: 'peer', backendId: 'local', traceId: 'peer-trace' }
      });
    }
  };
  const gateway = new McpGatewayServer(
    [
      {
        id: 'local',
        transport: 'http',
        endpoint: 'http://down/mcp',
        resultContract: 'native-json/v1'
      }
    ],
    { connectorFactory: () => failing }
  );
  await gateway.initialize();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gateway.connect(b);
  const client = new Client({ name: 'fault', version: '1' });
  await client.connect(a);
  try {
    await expect(client.callTool({ name: 'local__probe', arguments: {} })).rejects.toMatchObject({
      data: {
        category: 'invalid_result',
        executionDisposition: 'completed',
        source: { traceId: 'peer-trace' }
      }
    });
    expect(gateway.getInMemoryAuditEvents().at(-1)).toMatchObject({
      executionDisposition: 'completed',
      downstreamTraceId: 'peer-trace'
    });
  } finally {
    await client.close();
    await gateway.close();
  }
});

it('concurrent SDK sessions keep their independently negotiated versions in audit events', async () => {
  const gateway = new McpGatewayServer(
    [
      {
        id: 'local',
        transport: 'http',
        endpoint: 'http://down/mcp',
        resultContract: 'native-json/v1'
      }
    ],
    { connectorFactory: () => connector }
  );
  await gateway.initialize();
  const listener = gateway.startHttp({ port: 0 });
  await once(listener, 'listening');
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  const transportA = new StreamableHTTPClientTransport(url);
  const transportB = new StreamableHTTPClientTransport(url);
  const originalSend = transportA.send.bind(transportA);
  transportA.send = (message, options) =>
    originalSend(
      'method' in message && message.method === 'initialize'
        ? { ...message, params: { ...message.params, protocolVersion: '2025-03-26' } }
        : message,
      options
    );
  const clientA = new Client({ name: 'older-A', version: '1' });
  const clientB = new Client({ name: 'current-B', version: '1' });
  try {
    await Promise.all([
      clientA.connect(transportA as unknown as Parameters<Client['connect']>[0]),
      clientB.connect(transportB as unknown as Parameters<Client['connect']>[0])
    ]);
    await Promise.all([
      clientA.callTool({
        name: 'local__probe',
        arguments: {},
        _meta: { [CONTEXT_META_KEY]: { traceId: 'version-A' } }
      }),
      clientB.callTool({
        name: 'local__probe',
        arguments: {},
        _meta: { [CONTEXT_META_KEY]: { traceId: 'version-B' } }
      })
    ]);
    const events = gateway.getInMemoryAuditEvents();
    expect(events.find((event) => event.traceId === 'version-A')).toMatchObject({
      protocolVersion: '2025-03-26'
    });
    expect(events.find((event) => event.traceId === 'version-B')).toMatchObject({
      protocolVersion: '2025-11-25'
    });
    expect(new Set(events.map((event) => event.invocationId)).size).toBe(2);
  } finally {
    await Promise.allSettled([transportA.terminateSession(), transportB.terminateSession()]);
    await Promise.allSettled([clientA.close(), clientB.close()]);
    await gateway.close();
  }
});
