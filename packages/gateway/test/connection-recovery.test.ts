import { expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpClient, pinProtocolVersion } from '@ai-mcp/mcp-client';
import { createServer } from '../../mcp-server/src/index.js';
import { HttpConnector } from '../src/connectors/http.js';
import { StdioConnector } from '../src/connectors/stdio.js';

it('classifies a previously connected HTTP backend going offline as unavailable', async () => {
  const backend = createServer();
  const listener = backend.startHttp({ port: 0 });
  await once(listener, 'listening');
  const connector = new HttpConnector(
    `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`,
    1000
  );
  try {
    await connector.listTools();
    await backend.close();
    await expect(connector.callTool('echo', { text: 'offline' })).rejects.toMatchObject({
      category: 'backend_unavailable'
    });
  } finally {
    await connector.close();
    await backend.close();
  }
});

it('counts connection and discovery against one connector call deadline', async () => {
  let calls = 0;
  const server = new Server({ name: 'budget', version: '1' }, { capabilities: { tools: {} } });
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    await new Promise((r) => setTimeout(r, 40));
    return {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'budget', version: '1' }
    };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    await new Promise((r) => setTimeout(r, 40));
    return { tools: [{ name: 'probe', inputSchema: { type: 'object' } }] };
  });
  server.setRequestHandler(CallToolRequestSchema, async () => {
    calls++;
    return { content: [], structuredContent: { done: true } };
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const connector = new HttpConnector('http://unused', 60, {
    clientFactory: () => new McpClient(a, 1000)
  });
  try {
    await expect(connector.callTool('probe', {})).rejects.toMatchObject({
      category: 'backend_timeout'
    });
    expect(calls).toBe(0);
  } finally {
    await connector.close();
    await server.close();
  }
});

it('connector close releases an in-progress HTTP handshake before returning', async () => {
  let entered!: () => void;
  let disconnected!: () => void;
  const admitted = new Promise<void>((r) => {
    entered = r;
  });
  const peerClosed = new Promise<string>((r) => {
    disconnected = () => r('closed');
  });
  const backend = createHttpServer((_req, res) => {
    entered();
    res.once('close', disconnected);
  });
  backend.listen(0);
  await once(backend, 'listening');
  const connector = new HttpConnector(
    `http://127.0.0.1:${(backend.address() as AddressInfo).port}/mcp`,
    1500
  );
  const discovery = connector.listTools().catch(() => undefined);
  await admitted;
  try {
    await connector.close();
    expect(
      await Promise.race([
        peerClosed,
        new Promise<string>((r) => setTimeout(() => r('leaked'), 300))
      ])
    ).toBe('closed');
  } finally {
    backend.closeAllConnections();
    await discovery;
    await connector.close();
    await new Promise<void>((r) => backend.close(() => r()));
  }
});

it('closing a pinned HTTP client deletes only its own session', async () => {
  const owner = createServer();
  const listener = owner.startHttp({ port: 0, sessionMode: 'stateful' });
  await once(listener, 'listening');
  const url = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  const transport = new StreamableHTTPClientTransport(url);
  const client = new McpClient(
    pinProtocolVersion(transport as unknown as Parameters<Client['connect']>[0], '2025-03-26')
  );
  await client.connect();
  const sessionId = transport.sessionId;
  try {
    await client.close();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId ?? '' }
    });
    await response.body?.cancel();
    expect(response.status).toBe(404);
    expect(owner.activeProtocolInstanceCount).toBe(0);
  } finally {
    await client.close();
    await owner.close();
  }
});

it.each(['http', 'stdio'])(
  '%s reconnects on the next independent call without replaying a failed call',
  async (kind) => {
    const servers: Server[] = [];
    const transports: ConstructorParameters<typeof McpClient>[0][] = [];
    let calls = 0;
    for (let index = 0; index < 2; index++) {
      const server = new Server({ name: 'test', version: '1' }, { capabilities: { tools: {} } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [{ name: 'probe', inputSchema: { type: 'object' } }]
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => {
        calls++;
        if (index === 0) {
          await server.close();
          return { content: [] };
        }
        return { content: [], structuredContent: { recovered: true } };
      });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.connect(b);
      servers.push(server);
      transports.push(a);
    }
    let launches = 0;
    const clientFactory = () => {
      const transport = transports[launches++];
      if (!transport) throw new Error('unplanned reconnect');
      return new McpClient(transport);
    };
    const connector =
      kind === 'http'
        ? new HttpConnector('http://unused', 1000, { clientFactory })
        : new StdioConnector({ command: 'unused', clientFactory });
    try {
      await connector.listTools();
      await expect(connector.callTool('probe', {})).rejects.toMatchObject({
        category: 'backend_unavailable',
        permanent: true
      });
      expect((await connector.callTool('probe', {})).native.structuredContent).toEqual({
        recovered: true
      });
      expect(launches).toBe(2);
      expect(calls).toBe(2);
    } finally {
      await connector.close();
      await Promise.all(servers.map((server) => server.close()));
    }
  }
);
