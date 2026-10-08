import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { Server as HttpServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer, defineTool } from '../src/index.js';

async function portOf(server: HttpServer): Promise<number> {
  if (!server.listening) {
    await once(server, 'listening');
  }
  return (server.address() as AddressInfo).port;
}

const probe = defineTool({
  name: 'probe.echo',
  description: 'probe',
  inputSchema: z.strictObject({ marker: z.string() }),
  outputSchema: z.strictObject({ marker: z.string() }),
  handler: (input) => ({ marker: input.marker })
});

async function connectClient(port: number): Promise<Client> {
  const client = new Client({ name: 'lifecycle-client', version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    ) as unknown as Parameters<Client['connect']>[0]
  );
  return client;
}

describe('http lifecycle edges (stateful)', () => {
  it('expires idle sessions via TTL (fetch-only client without live streams)', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(probe);
    const httpServer = server.startHttp({
      port: 0,
      sessionMode: 'stateful',
      sessionIdleTimeoutMs: 400
    });
    const port = await portOf(httpServer);

    const initialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'ttl-client', version: '0' }
        }
      })
    });
    const sessionId = initialize.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    expect(server.activeProtocolInstanceCount).toBe(1);

    // Idle beyond the TTL: the sweeper reclaims the session.
    await new Promise((resolve) => setTimeout(resolve, 1400));
    expect(server.activeProtocolInstanceCount).toBe(0);

    const gone = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId ?? ''
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
    });
    expect(gone.status).toBe(404);

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 15_000);

  it('rejects new sessions beyond maxSessions with 503', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(probe);
    const httpServer = server.startHttp({ port: 0, sessionMode: 'stateful', maxSessions: 1 });
    const port = await portOf(httpServer);

    const first = await connectClient(port);
    expect(server.activeProtocolInstanceCount).toBe(1);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'overflow', version: '0' }
        }
      })
    });
    expect(response.status).toBe(503);

    await first.close();
    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 15_000);

  it('stops admitting requests after close and drops instance count to zero', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(probe);
    const httpServer = server.startHttp({ port: 0, sessionMode: 'stateful' });
    const port = await portOf(httpServer);

    const client = await connectClient(port);
    expect(server.activeProtocolInstanceCount).toBe(1);

    await server.close();
    expect(server.activeProtocolInstanceCount).toBe(0);
    await server.close();

    // close() owns the listener: after close the port is fully released
    // (connection refused) rather than serving 503s.
    const rejected = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list' })
    });
    await expect(rejected).rejects.toThrowError();

    const rebindProbe = createTcpServer();
    await new Promise<void>((resolve, reject) => {
      rebindProbe.listen(port, '127.0.0.1', () => resolve());
      rebindProbe.on('error', reject);
    });
    rebindProbe.close();

    await client.close().catch(() => undefined);
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 15_000);

  it('enforces the body size limit before parsing', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(probe);
    const httpServer = server.startHttp({ port: 0, maxBodySizeBytes: 64 });
    const port = await portOf(httpServer);

    const oversized = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: 'x'.repeat(200)
    });
    expect((await oversized).status).toBe(413);

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('rejects invalid JSON envelopes with 400', async () => {
    const server = createServer({ includeBuiltInTools: false });
    const httpServer = server.startHttp({ port: 0 });
    const port = await portOf(httpServer);

    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: 'not-json'
    });
    expect(response.status).toBe(400);

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('rejects initialize bodies the version policy hook denies', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(probe);
    const httpServer = server.startHttp({
      port: 0,
      sessionMode: 'stateful',
      validateInitializeVersion: (version) =>
        version === '2025-03-26'
          ? { ok: true }
          : { ok: false, message: `Version not allowed here: ${String(version)}` }
    });
    const port = await portOf(httpServer);

    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'policy-probe', version: '0' }
        }
      })
    });
    expect(denied.status).toBe(400);

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('applies the initialize body version policy hook', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(probe);
    const httpServer = server.startHttp({
      port: 0,
      sessionMode: 'stateful',
      maxBodySizeBytes: 1024 * 1024
    });
    const port = await portOf(httpServer);

    const initialize = await fetch(`http://127.0.0.1:${port}/mcp`, {
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
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'policy', version: '0' }
        }
      })
    });
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    await server.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }, 15_000);
});
