import { describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpClient } from '@ai-mcp/mcp-client';
import { HttpConnector } from '../src/connectors/http.js';
import { StdioConnector } from '../src/connectors/stdio.js';
import { DownstreamConnectorError } from '../src/connectors/base.js';

type ToolHandler = (request: {
  params?: { name?: string; arguments?: Record<string, unknown> };
}) => unknown;

function startDownstream(handlers: {
  pages?: { tools: unknown[]; nextCursor?: string }[];
  call?: ToolHandler;
}) {
  const server = new Server(
    { name: 'downstream', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  const calls: { name: string; arguments: unknown }[] = [];

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    const pages = handlers.pages ?? [];
    const index =
      cursor === undefined ? 0 : pages.findIndex((page) => page.nextCursor === cursor) + 1;
    if (index < 0 || index >= pages.length) {
      throw new Error(`unexpected cursor: ${String(cursor)}`);
    }
    return pages[index] as { tools: unknown[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params?.name ?? '';
    const args = request.params?.arguments ?? {};
    calls.push({ name, arguments: args });
    if (!handlers.call) {
      return { content: [{ type: 'text', text: 'ok' }], isError: false } as never;
    }
    return handlers.call({ params: { name, arguments: args } }) as never;
  });

  return { server, calls };
}

async function inMemoryConnector(handlers: Parameters<typeof startDownstream>[0]) {
  const { server, calls } = startDownstream(handlers);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const connector = new HttpConnector('http://in-memory.invalid/mcp', 5000, {
    clientFactory: () => new McpClient(clientTransport, 5000)
  });
  return { connector, server, calls };
}

describe('connectors on the unified client facade', () => {
  it('carries media-only success through the connector projection', async () => {
    const { connector, server } = await inMemoryConnector({
      pages: [{ tools: [{ name: 'media', inputSchema: { type: 'object' } }] }],
      call: () => ({ content: [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }] })
    });
    try {
      const result = await connector.callTool('media', {});
      expect(result.output.ok).toBe(true);
      expect(result.native.content[0]?.type).toBe('image');
    } finally {
      await connector.close();
      await server.close();
    }
  });
  it('HttpConnector.listTools returns full descriptors across all pages', async () => {
    const { connector, server } = await inMemoryConnector({
      pages: [
        {
          tools: [
            {
              name: 'catalog.lookup',
              description: 'lookup',
              inputSchema: { type: 'object', properties: { sku: { type: 'string' } } },
              outputSchema: { type: 'object', properties: { sku: { type: 'string' } } },
              annotations: { readOnlyHint: true }
            }
          ],
          nextCursor: 'p2'
        },
        { tools: [{ name: 'orders.list', description: 'orders', inputSchema: { type: 'object' } }] }
      ]
    });

    const tools = await connector.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['catalog.lookup', 'orders.list']);
    expect(tools[0]?.descriptor.annotations).toEqual({ readOnlyHint: true });
    expect(tools[0]?.descriptor.outputSchema).toBeDefined();

    await connector.close();
    await server.close();
  });

  it('keeps native error results and reflects them in the standard projection', async () => {
    const { connector, server } = await inMemoryConnector({
      pages: [
        {
          tools: [{ name: 'warehouse.reserve', description: 'w', inputSchema: { type: 'object' } }]
        }
      ],
      call: () => ({
        content: [{ type: 'text', text: JSON.stringify({ reason: 'out_of_stock' }) }],
        structuredContent: { reason: 'out_of_stock' },
        isError: true
      })
    });

    const result = await connector.callTool('warehouse.reserve', {});
    expect(result.native.isError).toBe(true);
    expect(result.native.structuredContent).toEqual({ reason: 'out_of_stock' });
    // The compatibility projection must not claim ok:true for a failure.
    expect(result.output.ok).toBe(false);

    await connector.close();
    await server.close();
  });

  it('preserves native success results including content-only payloads', async () => {
    const { connector, server } = await inMemoryConnector({
      pages: [
        { tools: [{ name: 'plain.text', description: 'p', inputSchema: { type: 'object' } }] }
      ],
      call: () => ({ content: [{ type: 'text', text: '{"text":"legacy-shape"}' }], isError: false })
    });

    const result = await connector.callTool('plain.text', {});
    expect(result.native.isError).toBe(false);
    expect(result.output.ok).toBe(true);
    expect(result.output.structuredContent).toEqual({ text: 'legacy-shape' });

    await connector.close();
    await server.close();
  });

  it('passes per-call context through to the downstream _meta', async () => {
    const { connector, server } = await inMemoryConnector({
      pages: [
        { tools: [{ name: 'trace.mirror', description: 't', inputSchema: { type: 'object' } }] }
      ],
      call: ({ params }) => ({
        content: [{ type: 'text', text: JSON.stringify({ sawMeta: Boolean(params?.arguments) }) }],
        structuredContent: { sawMeta: true },
        isError: false
      })
    });

    const result = await connector.callTool('trace.mirror', {}, undefined, {
      traceId: 'trace-connector-1',
      runId: 'run-9'
    });
    expect(result.native.isError).toBe(false);

    await connector.close();
    await server.close();
  });

  it('classifies an unreachable endpoint as backend_unavailable without retrying forever', async () => {
    const connector = new HttpConnector('http://127.0.0.1:1/mcp', 1000, {
      connectAttempts: 2,
      retryDelayMs: 10
    });
    await expect(connector.listTools()).rejects.toMatchObject({
      category: 'backend_unavailable'
    });
    await connector.close();
  }, 20_000);

  it('identifies stdio subprocess exit as backend_unavailable', async () => {
    const connector = new StdioConnector({
      command: process.execPath,
      args: ['-e', 'process.exit(7)'],
      timeoutMs: 3000
    });
    await expect(connector.listTools()).rejects.toMatchObject({
      category: 'backend_unavailable'
    });
    await connector.close();
  }, 20_000);

  it('executes a submitted tools/call exactly once', async () => {
    const { connector, server, calls } = await inMemoryConnector({
      pages: [
        { tools: [{ name: 'count.tool', description: 'c', inputSchema: { type: 'object' } }] }
      ]
    });

    await connector.callTool('count.tool', {});
    expect(calls).toHaveLength(1);

    await connector.close();
    await server.close();
  });

  it('cancels in-flight calls with a cancelled category, not a timeout', async () => {
    const { connector, server } = await inMemoryConnector({
      pages: [
        { tools: [{ name: 'slow.tool', description: 's', inputSchema: { type: 'object' } }] }
      ],
      call: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ content: [{ type: 'text', text: 'late' }] }), 400);
        })
    });

    const controller = new AbortController();
    const pending = connector.callTool('slow.tool', {}, controller.signal);
    setTimeout(() => controller.abort(new Error('gateway cancelled')), 30);
    await expect(pending).rejects.toMatchObject({ category: 'cancelled' });

    await connector.close();
    await server.close();
  });

  it('close is idempotent', async () => {
    const connector = new StdioConnector({
      command: process.execPath,
      args: ['--version'],
      timeoutMs: 3000
    });
    await connector.close();
    await connector.close();
  });

  it('wraps client errors as DownstreamConnectorError with preserved categories', () => {
    const error = new DownstreamConnectorError('backend_timeout', 'boom');
    expect(error.category).toBe('backend_timeout');
    expect(error.message).toBe('boom');
  });
});
