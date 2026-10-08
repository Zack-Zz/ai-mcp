import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, createServer as createTcpServer, type AddressInfo } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer, defineTool } from '../src/index.js';

import type { Server as HttpServer } from 'node:http';
import { once } from 'node:events';

async function portOf(server: HttpServer): Promise<number> {
  if (!server.listening) {
    await once(server, 'listening');
  }
  return (server.address() as AddressInfo).port;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createTcpServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
    probe.on('error', reject);
  });
}

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

function probeTool(gate: ReturnType<typeof barrier>) {
  return defineTool({
    name: 'probe.echo',
    description: 'barrier probe',
    inputSchema: z.strictObject({ marker: z.string() }),
    outputSchema: z.strictObject({ marker: z.string() }),
    handler: async (input) => {
      await gate.enter();
      return { marker: input.marker };
    }
  });
}

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: 'ownership-client', version: '0.0.1' });
  // SDK transport classes type optional callbacks with explicit undefined,
  // conflicting with exactOptionalPropertyTypes on the Transport interface.
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    ) as unknown as Parameters<Client['connect']>[0]
  );
  return client;
}

describe('server http ownership (stateless default)', () => {
  let port: number;
  let server: ReturnType<typeof createServer>;
  let httpServer: import('node:http').Server;
  const gate = barrier(2);

  beforeAll(async () => {
    server = createServer({ includeBuiltInTools: false });
    server.registerTool(probeTool(gate));
    httpServer = server.startHttp({ port: 0 });
    port = await portOf(httpServer);
  });

  afterAll(async () => {
    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('serves two independent clients with overlapping calls and per-client markers', async () => {
    const [a, b] = await Promise.all([connectClient(port), connectClient(port)]);

    const [listA, listB] = await Promise.all([a.listTools(), b.listTools()]);
    expect(listA.tools.map((tool) => tool.name)).toEqual(['probe.echo']);
    expect(listB.tools.map((tool) => tool.name)).toEqual(['probe.echo']);

    // Both calls must enter the handler before either completes: proof of
    // real overlap rather than accidental serialization.
    const [callA, callB] = await Promise.all([
      a.callTool({ name: 'probe.echo', arguments: { marker: 'client-A' } }),
      b.callTool({ name: 'probe.echo', arguments: { marker: 'client-B' } })
    ]);
    expect(gate.enteredCount()).toBe(2);
    expect(callA.structuredContent).toEqual({ marker: 'client-A' });
    expect(callB.structuredContent).toEqual({ marker: 'client-B' });

    // Closing A must not affect B's active or future calls.
    await a.close();
    const afterClose = await b.callTool({
      name: 'probe.echo',
      arguments: { marker: 'B-after-A-close' }
    });
    expect(afterClose.structuredContent).toEqual({ marker: 'B-after-A-close' });
    await b.close();
  });

  it('releases the port after close', async () => {
    const held = await freePort();
    const localServer = createServer();
    const localHttp = localServer.startHttp({ port: held });
    await portOf(localHttp);
    await localServer.close();
    await new Promise<void>((resolve) => localHttp.close(() => resolve()));

    const probe = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      probe.listen(held, '127.0.0.1', () => resolve());
      probe.on('error', reject);
    });
    probe.close();
  });
});

describe('server http ownership (stateful mode)', () => {
  let port: number;
  let server: ReturnType<typeof createServer>;
  let httpServer: import('node:http').Server;
  const gate = barrier(2);

  beforeAll(async () => {
    server = createServer({ includeBuiltInTools: false });
    server.registerTool(probeTool(gate));
    httpServer = server.startHttp({ port: 0, sessionMode: 'stateful' });
    port = await portOf(httpServer);
  });

  afterAll(async () => {
    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('isolates sessions: closing A leaves B fully functional', async () => {
    const [a, b] = await Promise.all([connectClient(port), connectClient(port)]);

    const [callA, callB] = await Promise.all([
      a.callTool({ name: 'probe.echo', arguments: { marker: 'session-A' } }),
      b.callTool({ name: 'probe.echo', arguments: { marker: 'session-B' } })
    ]);
    expect(callA.structuredContent).toEqual({ marker: 'session-A' });
    expect(callB.structuredContent).toEqual({ marker: 'session-B' });

    await a.close();
    const still = await b.callTool({ name: 'probe.echo', arguments: { marker: 'B-still-alive' } });
    expect(still.structuredContent).toEqual({ marker: 'B-still-alive' });
    await b.close();
  });

  it('rejects unknown sessions, missing sessions and duplicate headers', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'does-not-exist'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
      })
    });
    expect(response.status).toBe(404);

    const noSession = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(noSession.status).toBe(400);

    // Duplicate session headers over a raw socket must be rejected instead
    // of silently picking one of the values as identity.
    const duplicateStatus = await new Promise<number>((resolve, reject) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        const match = /HTTP\/1\.1 (\d+)/.exec(String(chunk));
        if (match) {
          resolve(Number(match[1]));
          socket.destroy();
        }
      });
      socket.end(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\n` +
          `Mcp-Session-Id: one\r\nMcp-Session-Id: two\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}`
      );
    });
    expect(duplicateStatus).toBe(400);
  });

  it('returns 405 for unsupported methods on a session', async () => {
    const init = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'method-test', version: '0' }
        }
      })
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const put = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'PUT',
      headers: {
        'mcp-session-id': sessionId ?? '',
        accept: 'application/json, text/event-stream'
      }
    });
    expect(put.status).toBe(405);
  });
});

describe('server http ownership (non-session paths)', () => {
  it('keeps /health independent of the MCP endpoint', async () => {
    const server = createServer();
    const httpServer = server.startHttp({ port: 0 });
    const port = await portOf(httpServer);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: 'ok' });

    const missing = await fetch(`http://127.0.0.1:${port}/not-found`);
    expect(missing.status).toBe(404);

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });
});
