import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { createServer as createHttpServer, request as requestHttp } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { McpClient } from '@ai-mcp/mcp-client';
import { createServer } from '../../mcp-server/src/index.js';
import { HttpConnector } from '../src/connectors/http.js';
import { StdioConnector } from '../src/connectors/stdio.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('overall review: connector contract projection', () => {
  it.each(['http', 'stdio'])(
    '%s propagates a typed discovery fault without retrying discovery as legacy',
    async (kind) => {
      const server = new Server(
        { name: 'typed-discovery', version: '1' },
        { capabilities: { tools: {} } }
      );
      let lists = 0;
      server.setRequestHandler(ListToolsRequestSchema, async () => {
        lists++;
        throw new McpError(-32601, 'Invalid descriptor store', {
          category: 'invalid_result',
          projectCode: 'INVALID_RESULT'
        });
      });
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [],
        structuredContent: { done: true }
      }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const clientFactory = () => new McpClient(clientTransport);
      const connector =
        kind === 'http'
          ? new HttpConnector('http://unused', 1000, { clientFactory })
          : new StdioConnector({ command: 'unused', clientFactory });
      try {
        await expect(connector.callTool('probe', {})).rejects.toMatchObject({
          category: 'invalid_result'
        });
        expect(lists).toBe(1);
      } finally {
        await connector.close();
        await server.close();
      }
    }
  );
  it.each(['http', 'stdio'])(
    '%s preserves direct-call compatibility when tools/list is explicitly unsupported',
    async (kind) => {
      const server = new Server(
        { name: 'old-direct-call', version: '1' },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [{ type: 'text', text: '{"ok":true,"code":"OK","message":"legacy"}' }]
      }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const clientFactory = () => new McpClient(clientTransport);
      const connector =
        kind === 'http'
          ? new HttpConnector('http://unused', 1000, { clientFactory })
          : new StdioConnector({ command: 'unused', clientFactory });
      try {
        expect((await connector.callTool('legacy', {})).output).toMatchObject({
          ok: true,
          code: 'OK',
          message: 'legacy'
        });
      } finally {
        await connector.close();
        await server.close();
      }
    }
  );
  it.each(['http', 'stdio'])(
    '%s preserves native business failure data as a successful query',
    async (kind) => {
      const server = new Server(
        { name: 'task-status', version: '1' },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'status',
            inputSchema: { type: 'object' },
            _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
          }
        ]
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [],
        structuredContent: { ok: false, code: 'FAILED_TASK', message: 'task failed' }
      }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const clientFactory = () => new McpClient(clientTransport);
      const connector =
        kind === 'http'
          ? new HttpConnector('http://unused', 1000, { clientFactory })
          : new StdioConnector({ command: 'unused', clientFactory });
      try {
        const result = await connector.callTool('status', {});
        expect(result.native.isError).toBe(false);
        expect(result.output.ok).toBe(true);
        expect(result.output.structuredContent).toEqual({
          ok: false,
          code: 'FAILED_TASK',
          message: 'task failed'
        });
      } finally {
        await connector.close();
        await server.close();
      }
    }
  );

  it.each(['http', 'stdio'])(
    '%s propagates the effective contract override through Client and projection',
    async (kind) => {
      const server = new Server(
        { name: 'native-override', version: '1' },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'catalog',
            inputSchema: { type: 'object' },
            outputSchema: {
              type: 'object',
              properties: { sku: { type: 'string' } },
              required: ['sku']
            },
            _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
          }
        ]
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [],
        structuredContent: { sku: 'sku-1' }
      }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const clientFactory = () => new McpClient(clientTransport);
      const connector =
        kind === 'http'
          ? new HttpConnector('http://unused', 1000, { clientFactory })
          : new StdioConnector({ command: 'unused', clientFactory });
      try {
        const result = await connector.callTool('catalog', {}, undefined, {
          resultContract: 'native-json/v1'
        });
        expect(result.output).toMatchObject({ ok: true, structuredContent: { sku: 'sku-1' } });
      } finally {
        await connector.close();
        await server.close();
      }
    }
  );

  it.each(['http', 'stdio'])(
    '%s preserves the declared standard error code rather than adding a second failure envelope',
    async (kind) => {
      const server = new Server(
        { name: 'standard-error', version: '1' },
        { capabilities: { tools: {} } }
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'deny',
            inputSchema: { type: 'object' },
            _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
          }
        ]
      }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({
        content: [],
        isError: true,
        structuredContent: {
          ok: false,
          code: 'BUSINESS_DENIED',
          message: 'closed',
          artifacts: [{ artifactId: 'a1', kind: 'log', uri: 'file:///a1' }]
        }
      }));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const clientFactory = () => new McpClient(clientTransport);
      const connector =
        kind === 'http'
          ? new HttpConnector('http://unused', 1000, { clientFactory })
          : new StdioConnector({ command: 'unused', clientFactory });
      try {
        const result = await connector.callTool('deny', {});
        expect(result.output.code).toBe('BUSINESS_DENIED');
        expect(result.output.artifacts).toHaveLength(1);
      } finally {
        await connector.close();
        await server.close();
      }
    }
  );
});

it.each(['http', 'stdio'])(
  '%s Connector.close waits for a retired client HTTP session DELETE to finish',
  async (kind) => {
    const owner = createServer();
    const backend = owner.startHttp({ port: 0, sessionMode: 'stateful' });
    await once(backend, 'listening');
    const backendPort = (backend.address() as AddressInfo).port;
    const deleteEntered = barrier();
    const deleteReleased = barrier();
    const proxy = createHttpServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const parsed: unknown = body.length ? JSON.parse(body.toString()) : undefined;
      if (
        parsed &&
        typeof parsed === 'object' &&
        'method' in parsed &&
        parsed.method === 'tools/call'
      ) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end('{"message":"maintenance"}');
        return;
      }
      if (req.method === 'DELETE') {
        deleteEntered.release();
        await deleteReleased.promise;
      }
      const upstream = requestHttp(
        {
          host: '127.0.0.1',
          port: backendPort,
          path: req.url,
          method: req.method,
          headers: req.headers
        },
        (response) => {
          res.writeHead(response.statusCode ?? 500, response.headers);
          response.pipe(res);
        }
      );
      upstream.on('error', () => res.destroy());
      res.on('close', () => upstream.destroy());
      upstream.end(body);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const endpoint = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/mcp`;
    const connector =
      kind === 'http'
        ? new HttpConnector(endpoint, 1000)
        : new StdioConnector({
            command: 'unused',
            timeoutMs: 1000,
            clientFactory: () =>
              new McpClient(
                new StreamableHTTPClientTransport(
                  new URL(endpoint)
                ) as unknown as ConstructorParameters<typeof McpClient>[0],
                1000
              )
          });
    try {
      await connector.listTools();
      await expect(connector.callTool('echo', { text: 'x' })).rejects.toMatchObject({
        category: 'backend_unavailable',
        permanent: true
      });
      await deleteEntered.promise;
      let closed = false;
      const close = connector.close().then(() => {
        closed = true;
      });
      // Observe a full event-loop turn while cleanup is held by a peer barrier.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      deleteReleased.release();
      await close;
      expect(owner.activeProtocolInstanceCount).toBe(0);
    } finally {
      deleteReleased.release();
      await connector.close();
      await owner.close();
      proxy.closeAllConnections();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }
);
