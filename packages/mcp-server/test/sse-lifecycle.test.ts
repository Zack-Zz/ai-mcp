import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createServer, defineTool } from '../src/index.js';

async function portOf(server: HttpServer): Promise<number> {
  if (!server.listening) {
    await once(server, 'listening');
  }
  return (server.address() as AddressInfo).port;
}

async function connectSse(port: number): Promise<Client> {
  const client = new Client({ name: 'sse-client', version: '0.0.1' });
  await client.connect(new SSEClientTransport(new URL(`http://127.0.0.1:${port}/sse`)));
  return client;
}

describe('server SSE ownership', () => {
  it('closes an active SSE transport once without reentering its onclose callback', async () => {
    const close = vi.spyOn(SSEServerTransport.prototype, 'close');
    const local = createServer({ shutdownGraceMs: 50 });
    const listener = local.startSse({ port: 0 });
    const client = await connectSse(await portOf(listener));
    try {
      await local.close();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      close.mockRestore();
      await client.close();
      await local.close();
    }
  });
  let port: number;
  let server: ReturnType<typeof createServer>;
  let httpServer: HttpServer;

  beforeAll(async () => {
    server = createServer({ includeBuiltInTools: false });
    server.registerTool(
      defineTool({
        name: 'sse.probe',
        description: 'sse probe',
        inputSchema: z.strictObject({ marker: z.string() }),
        outputSchema: z.strictObject({ marker: z.string() }),
        handler: (input) => ({ marker: input.marker })
      })
    );
    httpServer = server.startSse({ port: 0 });
    port = await portOf(httpServer);
  });

  afterAll(async () => {
    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('isolates two SSE clients: closing A leaves B functional', async () => {
    const [a, b] = await Promise.all([connectSse(port), connectSse(port)]);

    const [listA, listB] = await Promise.all([a.listTools(), b.listTools()]);
    expect(listA.tools.map((tool) => tool.name)).toEqual(['sse.probe']);
    expect(listB.tools.map((tool) => tool.name)).toEqual(['sse.probe']);

    const [callA, callB] = await Promise.all([
      a.callTool({ name: 'sse.probe', arguments: { marker: 'sse-A' } }),
      b.callTool({ name: 'sse.probe', arguments: { marker: 'sse-B' } })
    ]);
    expect(callA.structuredContent).toEqual({ marker: 'sse-A' });
    expect(callB.structuredContent).toEqual({ marker: 'sse-B' });

    await a.close();
    const after = await b.callTool({ name: 'sse.probe', arguments: { marker: 'B-after' } });
    expect(after.structuredContent).toEqual({ marker: 'B-after' });
    await b.close();
  }, 15_000);

  it('requires a sessionId on POST /sse/call', async () => {
    const response = await fetch(`http://127.0.0.1:${port}/sse/call`, { method: 'POST' });
    expect(response.status).toBe(400);
    const unknown = await fetch(`http://127.0.0.1:${port}/sse/call?sessionId=missing`, {
      method: 'POST'
    });
    expect(unknown.status).toBe(404);
  });

  it('releases all SSE sessions and the listener on close', async () => {
    const local = createServer();
    const http = local.startSse({ port: 0 });
    const localPort = await portOf(http);

    const client = await connectSse(localPort);
    await client.listTools();
    expect(local.activeProtocolInstanceCount).toBeGreaterThan(0);
    await client.close();

    // close() alone must own the SSE listener too: no manual http.close().
    await local.close();
    expect(local.activeProtocolInstanceCount).toBe(0);

    const rebind = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      rebind.listen(localPort, '127.0.0.1', () => resolve());
      rebind.on('error', reject);
    });
    rebind.close();
  }, 15_000);
});
