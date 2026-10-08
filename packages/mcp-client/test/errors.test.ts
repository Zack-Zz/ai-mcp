import { describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer as createTcpServer } from 'node:net';
import { McpClient, McpClientError } from '../src/client.js';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createTcpServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('no port')));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

describe('connection failure classification', () => {
  it('classifies an unreachable HTTP endpoint as backend_unavailable', async () => {
    const port = await freePort();
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    ) as unknown as ConstructorParameters<typeof McpClient>[0];
    const client = new McpClient(transport, 2000);

    await expect(client.connect()).rejects.toMatchObject({
      category: 'backend_unavailable'
    });
    await expect(client.listTools()).rejects.toMatchObject({
      category: 'backend_unavailable'
    });
  });

  it('classifies connect deadlines as backend_timeout without hanging forever', async () => {
    const port = await freePort();
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${port}/mcp`)
    ) as unknown as ConstructorParameters<typeof McpClient>[0];
    // Nothing listens but no RST either is impossible on loopback, so use a
    // connectTimeoutMs smaller than the OS-level failure to prove the budget.
    const client = new McpClient(transport, { connectTimeoutMs: 60, requestTimeoutMs: 2000 });
    const started = Date.now();
    await expect(client.connect()).rejects.toMatchObject({
      category: expect.stringMatching(/backend_timeout|backend_unavailable/)
    });
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('identifies stdio subprocess exit as backend_unavailable', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['-e', 'process.exit(3)']
    });
    const client = new McpClient(transport, 5000);

    const error = await client.connect().then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(McpClientError);
    expect((error as McpClientError).category).toBe('backend_unavailable');
  }, 10_000);
});

describe('request failure classification', () => {
  it('separates request timeout from cancellation', async () => {
    const slowServer = new Server(
      { name: 'slow', version: '0.0.1' },
      { capabilities: { tools: {} } }
    );
    slowServer.setRequestHandler(CallToolRequestSchema, async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return { content: [{ type: 'text', text: 'late' }], isError: false } as never;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await slowServer.connect(serverTransport);

    const timeoutClient = new McpClient(clientTransport, { requestTimeoutMs: 60 });
    await timeoutClient.connect();
    await expect(timeoutClient.callToolResult('any.tool', {})).rejects.toMatchObject({
      category: 'backend_timeout'
    });
    await timeoutClient.close();

    const [clientTransport2, serverTransport2] = InMemoryTransport.createLinkedPair();
    await slowServer.connect(serverTransport2);
    const cancelClient = new McpClient(clientTransport2, { requestTimeoutMs: 5000 });
    await cancelClient.connect();
    const controller = new AbortController();
    const pending = cancelClient.callToolResult('any.tool', {}, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller cancelled')), 30);
    await expect(pending).rejects.toMatchObject({ category: 'cancelled' });
    await cancelClient.close();
    await slowServer.close();
  });
});

describe('execution-once and transport reuse', () => {
  it('never replays a submitted tools/call after a failed connection attempt', async () => {
    let calls = 0;
    const server = new Server(
      { name: 'counting', version: '0.0.1' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(CallToolRequestSchema, async () => {
      calls += 1;
      return { content: [{ type: 'text', text: 'done' }], isError: false } as never;
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new McpClient(clientTransport, 1000);
    await client.connect();

    const result = await client.callToolResult('count.tool', {});
    expect(result.isError).toBe(false);
    expect(calls).toBe(1);

    await client.close();
    await server.close();
  });

  it('rejects new calls after close', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: 'plain', version: '0.0.1' }, { capabilities: { tools: {} } });
    await server.connect(serverTransport);
    const client = new McpClient(clientTransport, 1000);
    await client.connect();
    await client.close();
    await client.close();

    await expect(client.listTools()).rejects.toMatchObject({ category: 'backend_unavailable' });
    await server.close();
  });
});
