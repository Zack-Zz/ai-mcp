import { describe, expect, it } from 'vitest';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ToolDescriptor } from '@ai-mcp/shared';
import { McpClient } from '../src/client.js';

type Page = { tools: unknown[]; nextCursor?: string };

function startFakeServer(handlers: {
  pages?: Page[];
  callHandler?: (request: { params?: { name?: string; arguments?: unknown } }) => unknown;
}) {
  const server = new Server(
    { name: 'fake-tools', version: '0.0.1' },
    { capabilities: { tools: {} } }
  );
  const seenCursors: (string | undefined)[] = [];
  let callCount = 0;

  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const cursor = request.params?.cursor;
    seenCursors.push(cursor);
    const pages = handlers.pages ?? [];
    const index =
      cursor === undefined ? 0 : pages.findIndex((page) => page.nextCursor === cursor) + 1;
    if (index < 0 || index >= pages.length) {
      throw new Error(`unexpected cursor: ${String(cursor)}`);
    }
    return pages[index] as { tools: unknown[] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    callCount += 1;
    const handler = handlers.callHandler;
    if (!handler) {
      return { content: [{ type: 'text', text: 'ok' }], isError: false } as never;
    }
    return handler(request) as never;
  });

  return {
    server,
    state: {
      seenCursors,
      get callCount() {
        return callCount;
      }
    }
  };
}

async function connectClient(server: Server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new McpClient(clientTransport, 2000);
  await client.connect();
  return client;
}

const fullDescriptorTool = {
  name: 'catalog.lookup',
  description: 'lookup',
  title: 'Catalog Lookup',
  inputSchema: {
    type: 'object',
    properties: { sku: { type: 'string' } },
    required: ['sku']
  },
  outputSchema: {
    type: 'object',
    properties: { sku: { type: 'string' } },
    required: ['sku']
  },
  annotations: { readOnlyHint: true },
  _meta: { 'org.ai-mcp/source': 'unit' }
};

describe('discoverTools', () => {
  it('consumes all pages and keeps full descriptors', async () => {
    const { server } = startFakeServer({
      pages: [
        { tools: [fullDescriptorTool], nextCursor: 'page-2' },
        {
          tools: [{ name: 'orders.list', description: 'orders', inputSchema: { type: 'object' } }],
          nextCursor: 'page-3'
        },
        { tools: [{ name: 'time', description: 'time', inputSchema: { type: 'object' } }] }
      ]
    });
    const client = await connectClient(server);

    const tools = await client.discoverTools();
    expect(tools.map((tool) => tool.name)).toEqual(['catalog.lookup', 'orders.list', 'time']);

    const descriptor = tools[0] as ToolDescriptor;
    expect(descriptor.title).toBe('Catalog Lookup');
    expect(descriptor.annotations).toEqual({ readOnlyHint: true });
    expect(descriptor._meta).toEqual({ 'org.ai-mcp/source': 'unit' });
    expect(descriptor.outputSchema).toBeDefined();
    const inputSchema = descriptor.inputSchema as Record<string, unknown>;
    expect((inputSchema.properties as Record<string, unknown>).sku).toBeDefined();

    await client.close();
    await server.close();
  });

  it('fails clearly when a cursor repeats (loop detection)', async () => {
    const { server } = startFakeServer({
      pages: [
        {
          tools: [{ name: 'a', description: 'a', inputSchema: { type: 'object' } }],
          nextCursor: 'same'
        },
        {
          tools: [{ name: 'b', description: 'b', inputSchema: { type: 'object' } }],
          nextCursor: 'same'
        }
      ]
    });
    const client = await connectClient(server);

    await expect(client.discoverTools()).rejects.toThrowError(/cursor/i);

    await client.close();
    await server.close();
  });

  it('fails when a page advertises duplicate tool names', async () => {
    const { server } = startFakeServer({
      pages: [
        {
          tools: [{ name: 'dup', description: 'first', inputSchema: { type: 'object' } }],
          nextCursor: 'p2'
        },
        { tools: [{ name: 'dup', description: 'second', inputSchema: { type: 'object' } }] }
      ]
    });
    const client = await connectClient(server);

    await expect(client.discoverTools()).rejects.toThrowError(/duplicate/i);

    await client.close();
    await server.close();
  });

  it('rejects descriptors with malformed schemas before caching', async () => {
    const { server } = startFakeServer({
      pages: [{ tools: [{ name: 'bad', description: 'bad', inputSchema: { type: 'nope' } }] }]
    });
    const client = await connectClient(server);

    await expect(client.discoverTools()).rejects.toThrowError(/inputSchema|schema/i);

    await client.close();
    await server.close();
  });
});
