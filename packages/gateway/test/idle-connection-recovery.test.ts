import { describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '@ai-mcp/mcp-client';
import { HttpConnector } from '../src/connectors/http.js';
import { StdioConnector } from '../src/connectors/stdio.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function stdioFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-mcp-idle-'));
  const log = join(directory, 'events.jsonl');
  await writeFile(log, '');
  const clients: McpClient[] = [];
  const transports: StdioClientTransport[] = [];
  const closed: ReturnType<typeof barrier>[] = [];
  const connector = new StdioConnector({
    command: process.execPath,
    timeoutMs: 5000,
    clientFactory: () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [
          fileURLToPath(new URL('./fixtures/stdio-lifecycle-server.mjs', import.meta.url)),
          log
        ]
      });
      const close = barrier();
      transport.onclose = close.release;
      const client = new McpClient(transport, 5000);
      vi.spyOn(client, 'close');
      clients.push(client);
      transports.push(transport);
      closed.push(close);
      return client;
    }
  });
  return {
    connector,
    clients,
    transports,
    closed,
    events: async () =>
      (await readFile(log, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { kind: string; generation: number; pid: number }),
    cleanup: async () => {
      await connector.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

async function httpFixture() {
  const sessions = new Map<
    string,
    { server: Server; transport: StreamableHTTPServerTransport; generation: number }
  >();
  const clients: McpClient[] = [];
  const transports: StreamableHTTPClientTransport[] = [];
  const slowEntered = barrier();
  const releaseSlow = barrier();
  const listEntered = barrier();
  const releaseList = barrier();
  const lists = new Map<number, number>();
  const disconnects = new Map<string | number, () => void>();
  let holdList = false;
  let generations = 0;
  let calls = 0;
  let executions = 0;
  const listener = createServer(async (req, res) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let session = sessionId ? sessions.get(sessionId) : undefined;
    if (sessionId && !session) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    if (req.method === 'POST') for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    if (body?.method === 'tools/call') calls++;
    if (body?.method === 'tools/call' && body.params.arguments.disconnect)
      disconnects.set(body.id, () => res.destroy());
    // A single HTTP request can fail while a sibling tools/call is still executing.
    if (body?.method === 'tools/call' && body.params.arguments.failHttp) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (!session) {
      const generation = ++generations;
      const server = new Server(
        { name: 'http-lifecycle', version: '1' },
        { capabilities: { tools: {} } }
      );
      const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized: (id): void => {
          sessions.set(id, { server, transport, generation });
        }
      });
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        lists.set(generation, (lists.get(generation) ?? 0) + 1);
        if (holdList) {
          holdList = false;
          listEntered.release();
          await releaseList.promise;
        }
        return {
          tools: [
            {
              name: 'probe',
              inputSchema: {
                type: 'object',
                properties: { generation: { const: generation } },
                required: ['generation']
              },
              _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
            }
          ]
        };
      });
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        executions++;
        if (request.params.arguments?.slow) {
          slowEntered.release();
          await releaseSlow.promise;
        }
        if (request.params.arguments?.disconnect) {
          sessions.delete(transport.sessionId!);
          disconnects.get(extra.requestId)?.();
          await server.close();
        }
        return { content: [], structuredContent: { generation } };
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport as unknown as Transport);
      session = { server, transport, generation };
    }
    await session.transport.handleRequest(req, res, body);
  });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const endpoint = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
  const connector = new HttpConnector(endpoint.toString(), 5000, {
    clientFactory: () => {
      const transport = new StreamableHTTPClientTransport(endpoint);
      const client = new McpClient(
        transport as unknown as ConstructorParameters<typeof McpClient>[0],
        5000
      );
      vi.spyOn(client, 'close');
      transports.push(transport);
      clients.push(client);
      return client;
    }
  });
  return {
    connector,
    clients,
    transports,
    sessions,
    slowEntered,
    releaseSlow,
    listEntered,
    releaseList,
    lists,
    holdNextList: () => {
      holdList = true;
    },
    calls: () => calls,
    executions: () => executions,
    generations: () => generations,
    expire: async () => {
      const old = [...sessions.values()][0]!;
      sessions.delete(old.transport.sessionId!);
      await old.server.close();
    },
    cleanup: async () => {
      releaseSlow.release();
      releaseList.release();
      await connector.close();
      await Promise.all([...sessions.values()].map(({ server }) => server.close()));
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  };
}

describe('idle connection recovery over real transports', () => {
  it('restarts an idle stdio child, refreshes the catalog and never revives after close', async () => {
    const f = await stdioFixture();
    try {
      await f.connector.listTools();
      expect(
        (await f.connector.callTool('probe', { generation: 1 })).native.structuredContent
      ).toMatchObject({ generation: 1 });
      const pid = f.transports[0]!.pid!;
      process.kill(pid, 'SIGTERM');
      await f.closed[0]!.promise;
      await expect(f.clients[0]!.listTools()).rejects.toMatchObject({
        category: 'backend_unavailable',
        permanent: true
      });
      expect(
        (await f.connector.callTool('probe', { generation: 2 })).native.structuredContent
      ).toMatchObject({ generation: 2 });
      expect(f.clients[0]!.close).toHaveBeenCalledTimes(1);
      expect(f.transports[0]!.pid).toBeNull();
      expect((await f.events()).filter((e) => e.kind === 'call')).toHaveLength(2);
      await f.connector.close();
      await expect(f.connector.callTool('probe', { generation: 3 })).rejects.toMatchObject({
        category: 'backend_unavailable'
      });
      await expect(f.connector.listTools()).rejects.toMatchObject({
        category: 'backend_unavailable'
      });
      expect(f.clients).toHaveLength(2);
      expect(f.transports[1]!.pid).toBeNull();
    } finally {
      await f.cleanup();
    }
  }, 15000);

  it('never replays a stdio call whose side effect ran before subprocess exit', async () => {
    const f = await stdioFixture();
    try {
      await f.connector.listTools();
      await expect(
        f.connector.callTool('probe', { generation: 1, exit: true })
      ).rejects.toMatchObject({ category: 'backend_unavailable', permanent: true });
      expect((await f.events()).filter((e) => e.kind === 'call')).toHaveLength(1);
      expect(
        (await f.connector.callTool('probe', { generation: 2 })).native.structuredContent
      ).toMatchObject({ generation: 2 });
      expect((await f.events()).filter((e) => e.kind === 'call')).toHaveLength(2);
      expect(f.clients).toHaveLength(2);
      expect(f.clients[0]!.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  }, 15000);

  it('replaces an expired idle HTTP session on an independent operation without replay', async () => {
    const f = await httpFixture();
    try {
      await f.connector.listTools();
      await f.connector.callTool('probe', { generation: 1 });
      await f.expire();
      await expect(f.connector.callTool('probe', { generation: 1 })).rejects.toMatchObject({
        category: 'backend_unavailable',
        permanent: true
      });
      expect(f.calls()).toBe(1);
      expect(
        (await f.connector.callTool('probe', { generation: 2 })).native.structuredContent
      ).toEqual({ generation: 2 });
      expect(f.calls()).toBe(2);
      expect(f.clients[0]!.close).toHaveBeenCalledTimes(1);
      expect(f.sessions.size).toBe(1);
      await f.connector.close();
      expect(f.sessions.size).toBe(0);
      await expect(f.connector.listTools()).rejects.toMatchObject({
        category: 'backend_unavailable'
      });
      expect(f.generations()).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  it('does not abort a concurrent HTTP call when retiring a request-failed client', async () => {
    const f = await httpFixture();
    try {
      await f.connector.listTools();
      const slow = f.connector.callTool('probe', { generation: 1, slow: true });
      const observed = slow.then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      );
      await f.slowEntered.promise;
      await expect(
        f.connector.callTool('probe', { generation: 1, failHttp: true })
      ).rejects.toMatchObject({ category: 'backend_unavailable' });
      // A new independent caller can already use the replacement client.
      expect(
        (await f.connector.callTool('probe', { generation: 2 })).native.structuredContent
      ).toEqual({ generation: 2 });
      f.releaseSlow.release();
      expect(await observed).toMatchObject({
        value: { native: { structuredContent: { generation: 1 } } }
      });
      expect(f.calls()).toBe(3);
      expect(f.executions()).toBe(2);
      await f.connector.close();
      expect(f.sessions.size).toBe(0);
    } finally {
      await f.cleanup();
    }
  });

  it('does not let retired HTTP discovery overwrite the replacement catalog', async () => {
    const f = await httpFixture();
    try {
      await f.connector.listTools();
      f.holdNextList();
      const oldDiscovery = f.connector.listTools();
      await f.listEntered.promise;
      await expect(
        f.connector.callTool('probe', { generation: 1, failHttp: true })
      ).rejects.toMatchObject({ category: 'backend_unavailable' });
      await f.connector.callTool('probe', { generation: 2 });
      f.releaseList.release();
      await oldDiscovery;
      await f.connector.callTool('probe', { generation: 2 });
      expect(f.lists.get(2)).toBe(1);
      expect(f.calls()).toBe(3);
      expect(f.executions()).toBe(2);
    } finally {
      await f.cleanup();
    }
  });

  it('never replays a real HTTP call after its side effect and socket disconnect', async () => {
    const f = await httpFixture();
    try {
      await f.connector.listTools();
      await expect(
        f.connector.callTool('probe', { generation: 1, disconnect: true })
      ).rejects.toMatchObject({ category: 'backend_unavailable', permanent: true });
      expect(f.calls()).toBe(1);
      expect(f.executions()).toBe(1);
      expect(
        (await f.connector.callTool('probe', { generation: 2 })).native.structuredContent
      ).toEqual({ generation: 2 });
      expect(f.calls()).toBe(2);
      expect(f.executions()).toBe(2);
      expect(f.clients[0]!.close).toHaveBeenCalledTimes(1);
    } finally {
      await f.cleanup();
    }
  });

  it('shutdown closes both an active and a retired HTTP client with calls in flight', async () => {
    const f = await httpFixture();
    try {
      await f.connector.listTools();
      const slow = f.connector
        .callTool('probe', { generation: 1, slow: true })
        .catch((error: unknown) => error);
      await f.slowEntered.promise;
      await expect(
        f.connector.callTool('probe', { generation: 1, failHttp: true })
      ).rejects.toMatchObject({ category: 'backend_unavailable' });
      await f.connector.callTool('probe', { generation: 2 });
      await f.connector.close();
      expect(await slow).toMatchObject({ category: 'cancelled' });
      expect(f.clients.every((client) => !client.isConnected)).toBe(true);
      await expect(f.connector.callTool('probe', { generation: 3 })).rejects.toMatchObject({
        category: 'backend_unavailable'
      });
      expect(f.generations()).toBe(2);
    } finally {
      await f.cleanup();
    }
  });
});
