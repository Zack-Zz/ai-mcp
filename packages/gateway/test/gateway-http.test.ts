import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { NativeToolResult, ToolDescriptor } from '@ai-mcp/shared';
import { McpGatewayServer } from '../src/gateway-server.js';
import type { DownstreamConnector } from '../src/connectors/base.js';

function barrier(parties: number) {
  let entered = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async enter(): Promise<void> {
      entered += 1;
      if (entered >= parties) {
        release();
      }
      await released;
    },
    enteredCount(): number {
      return entered;
    }
  };
}

class BarrierConnector implements DownstreamConnector {
  public callCount = 0;
  public closeCount = 0;

  public constructor(private readonly gate: ReturnType<typeof barrier>) {}

  public async listTools() {
    const descriptor: ToolDescriptor = {
      name: 'probe',
      description: 'barrier probe',
      inputSchema: {
        type: 'object',
        properties: { marker: { type: 'string' } },
        required: ['marker']
      }
    };
    return [{ name: descriptor.name, description: descriptor.description ?? '', descriptor }];
  }

  public async callTool(
    name: string,
    args: unknown,
    _signal?: AbortSignal,
    _context?: { traceId?: string; runId?: string; taskId?: string }
  ): Promise<{
    durationMs: number;
    output: { ok: boolean; code: string; message: string; structuredContent: { marker: string } };
    native: NativeToolResult;
  }> {
    void _signal;
    void _context;
    await this.gate.enter();
    this.callCount += 1;
    const marker = (args as { marker?: string })?.marker ?? 'none';
    const native: NativeToolResult = {
      content: [{ type: 'text', text: JSON.stringify({ marker }) }],
      structuredContent: { marker },
      isError: false
    };
    return {
      durationMs: 1,
      output: {
        ok: true,
        code: 'OK',
        message: 'Tool call succeeded',
        structuredContent: { marker }
      },
      native
    };
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

async function portOf(server: HttpServer): Promise<number> {
  if (!server.listening) {
    await once(server, 'listening');
  }
  return (server.address() as AddressInfo).port;
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: 'gateway-ownership-client', version: '0.0.1' });
  // SDK transports type optional callbacks with explicit undefined, which
  // conflicts with exactOptionalPropertyTypes on the Transport interface.
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    ) as unknown as Parameters<Client['connect']>[0]
  );
  return client;
}

describe('gateway http ownership (stateful default)', () => {
  let port: number;
  let gateway: McpGatewayServer;
  let httpServer: HttpServer;
  const gate = barrier(2);
  let connector: BarrierConnector;

  beforeAll(async () => {
    connector = new BarrierConnector(gate);
    gateway = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://downstream/mcp' }],
      { connectorFactory: () => connector }
    );
    await gateway.initialize();
    httpServer = gateway.startHttp({ port: 0 });
    port = await portOf(httpServer);
  });

  afterAll(async () => {
    await gateway.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('runs two independent clients with overlapping calls through the shared downstream', async () => {
    const [a, b] = await Promise.all([connectClient(port), connectClient(port)]);

    const [listA, listB] = await Promise.all([a.listTools(), b.listTools()]);
    expect(listA.tools.map((tool) => tool.name)).toEqual(['local__probe']);
    expect(listB.tools.map((tool) => tool.name)).toEqual(['local__probe']);
    // Both clients used JSON-RPC id 1 for listTools; results must not cross.
    expect(listA.tools[0]?.name).toBe(listB.tools[0]?.name);

    const gate2 = barrier(2);
    const single = new BarrierConnector(gate2);
    const gw2 = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://downstream/mcp' }],
      { connectorFactory: () => single }
    );
    await gw2.initialize();
    const http2 = gw2.startHttp({ port: 0 });
    const port2 = await portOf(http2);
    const [c, d] = await Promise.all([connectClient(port2), connectClient(port2)]);
    const [callC, callD] = await Promise.all([
      c.callTool({ name: 'local__probe', arguments: { marker: 'C' } }),
      d.callTool({ name: 'local__probe', arguments: { marker: 'D' } })
    ]);
    expect(gate2.enteredCount()).toBe(2);
    expect(callC.structuredContent).toMatchObject({
      ok: true,
      structuredContent: { marker: 'C' }
    });
    expect(callD.structuredContent).toMatchObject({
      ok: true,
      structuredContent: { marker: 'D' }
    });
    await c.close();
    await d.close();
    await gw2.close();
    await new Promise<void>((resolve) => http2.close(() => resolve()));

    await a.close();
    await b.close();
  });

  it('keeps B alive and the shared connector open while A closes mid-flight', async () => {
    let releaseB!: () => void;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseB = resolve;
    });
    let calls = 0;
    let closes = 0;

    const gatedConnector: DownstreamConnector = {
      async listTools() {
        const descriptor: ToolDescriptor = {
          name: 'probe',
          description: 'gated probe',
          inputSchema: { type: 'object', properties: { marker: { type: 'string' } } }
        };
        return [{ name: descriptor.name, description: 'gated probe', descriptor }];
      },
      async callTool(name: string, args: unknown) {
        calls += 1;
        const marker = (args as { marker?: string })?.marker ?? 'none';
        if (marker === 'B-inflight') {
          signalEntered();
          await release;
        }
        const native: NativeToolResult = {
          content: [{ type: 'text', text: JSON.stringify({ marker }) }],
          structuredContent: { marker },
          isError: false
        };
        return {
          durationMs: 1,
          output: {
            ok: true,
            code: 'OK',
            message: 'Tool call succeeded',
            structuredContent: { marker }
          },
          native
        };
      },
      async close() {
        closes += 1;
      }
    };

    const gw3 = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://downstream/mcp' }],
      { connectorFactory: () => gatedConnector }
    );
    await gw3.initialize();
    const http3 = gw3.startHttp({ port: 0 });
    const port3 = await portOf(http3);

    const [a, b] = await Promise.all([connectClient(port3), connectClient(port3)]);

    const pendingB = b.callTool({ name: 'local__probe', arguments: { marker: 'B-inflight' } });
    await entered; // B is now inside the downstream handler.

    await a.close();
    releaseB();
    const resultB = await pendingB;
    expect(resultB.structuredContent).toMatchObject({
      ok: true,
      structuredContent: { marker: 'B-inflight' }
    });

    const after = await b.callTool({ name: 'local__probe', arguments: { marker: 'B-after' } });
    expect(after.structuredContent).toMatchObject({ structuredContent: { marker: 'B-after' } });

    // A's close must not have touched the shared downstream connector.
    expect(closes).toBe(0);
    expect(calls).toBe(2);

    await b.close();
    await gw3.close();
    await new Promise<void>((resolve) => http3.close(() => resolve()));
  });

  it('rejects unknown sessions and non-initialize requests without a session', async () => {
    const unknownSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'no-such-session'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(unknownSession.status).toBe(404);

    const noSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(noSession.status).toBe(400);
  });

  it('rejects follow-up headers that contradict the negotiated session version', async () => {
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'mismatch-probe', version: '0' }
        }
      })
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const mismatch = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId ?? '',
        'mcp-protocol-version': '2025-11-25'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 21, method: 'tools/list' })
    });
    expect(mismatch.status).toBe(400);

    const matched = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId ?? '',
        'mcp-protocol-version': '2025-03-26'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 22, method: 'tools/list' })
    });
    expect(matched.status).toBe(200);
  });

  it('validates the initialize body version, not only follow-up headers', async () => {
    const legacyBody = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'legacy-probe', version: '0' }
        }
      })
    });
    expect(legacyBody.status).toBe(400);
    const payload = (await legacyBody.json()) as { error?: { message?: string } };
    expect(payload.error?.message).toMatch(/2024-11-05|legacy/i);
  });
});

describe('gateway http edge branches', () => {
  it('answers 405 for GET without a session in stateless mode and 503 while stopping', async () => {
    const gate = barrier(1);
    const connector = new BarrierConnector(gate);
    const gateway = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://down/mcp' }],
      { connectorFactory: () => connector }
    );
    await gateway.initialize();
    const httpServer = gateway.startHttp({ port: 0, sessionMode: 'stateless' });
    const port = await portOf(httpServer);

    const get = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream' }
    });
    expect(get.status).toBe(405);

    const withSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'whatever'
      },
      body: '{}'
    });
    expect(withSession.status).toBe(400);

    await gateway.close();
    // close() releases the listener: subsequent connections are refused
    // and the port becomes bindable again.
    await expect(
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: '{}'
      })
    ).rejects.toThrowError();

    const probe = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      probe.listen(port, '127.0.0.1', () => resolve());
      probe.on('error', reject);
    });
    probe.close();

    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('hides tools whose capability visibility is hidden', async () => {
    const gate = barrier(1);
    const connector = new BarrierConnector(gate);
    const gateway = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://down/mcp' }],
      {
        connectorFactory: () => connector,
        capabilities: { toolOverrides: { local__probe: { visibility: 'hidden' } } }
      }
    );
    await gateway.initialize();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.connect(serverTransport);
    const client = new Client({ name: 'hidden', version: '0' });
    await client.connect(clientTransport);

    const list = await client.listTools();
    expect(list.tools).toHaveLength(0);
    await expect(
      client.callTool({ name: 'local__probe', arguments: { marker: 'x' } })
    ).rejects.toThrowError();

    await client.close();
    await gateway.close();
  });
});

describe('gateway http ownership (stateless mode)', () => {
  it('serves independent per-request instances without sessions', async () => {
    const gate = barrier(2);
    const connector = new BarrierConnector(gate);
    const gateway = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://downstream/mcp' }],
      { connectorFactory: () => connector }
    );
    await gateway.initialize();
    const httpServer = gateway.startHttp({ port: 0, sessionMode: 'stateless' });
    const port = await portOf(httpServer);

    const [a, b] = await Promise.all([connectClient(port), connectClient(port)]);
    const [callA, callB] = await Promise.all([
      a.callTool({ name: 'local__probe', arguments: { marker: 'stateless-A' } }),
      b.callTool({ name: 'local__probe', arguments: { marker: 'stateless-B' } })
    ]);
    expect(gate.enteredCount()).toBe(2);
    expect(callA.structuredContent).toMatchObject({ structuredContent: { marker: 'stateless-A' } });
    expect(callB.structuredContent).toMatchObject({ structuredContent: { marker: 'stateless-B' } });

    await a.close();
    const after = await b.callTool({ name: 'local__probe', arguments: { marker: 'B-alone' } });
    expect(after.structuredContent).toMatchObject({ structuredContent: { marker: 'B-alone' } });
    await b.close();

    await gateway.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
