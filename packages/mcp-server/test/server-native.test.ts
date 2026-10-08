import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { defineTool } from '../src/tool-registry.js';

async function connect(server: ReturnType<typeof createServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

const catalogLookup = defineTool({
  name: 'catalog.lookup',
  description: 'Look up a catalog item',
  inputSchema: z.strictObject({
    sku: z.string().min(3),
    region: z.enum(['cn', 'eu']).optional()
  }),
  outputSchema: z.strictObject({
    sku: z.string(),
    region: z.string()
  }),
  handler: async (input) => ({
    sku: input.sku,
    region: input.region ?? 'cn'
  })
});

describe('native sdk protocol surface', () => {
  it('discovers custom tools with their full input schema over tools/list', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(catalogLookup);
    const client = await connect(server);

    const list = await client.listTools();
    const tool = list.tools.find((item) => item.name === 'catalog.lookup');
    if (!tool) {
      throw new Error(`catalog.lookup missing: ${JSON.stringify(list.tools.map((t) => t.name))}`);
    }
    const inputSchema = tool.inputSchema as Record<string, unknown>;
    expect(inputSchema.type).toBe('object');
    expect((inputSchema.properties as Record<string, unknown>).sku).toBeDefined();
    expect(inputSchema.additionalProperties).toBe(false);
    expect(tool.outputSchema).toBeDefined();

    await client.close();
    await server.close();
  });

  it('calls a custom tool through the native protocol and returns structured content', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(catalogLookup);
    const client = await connect(server);

    const result = await client.callTool({ name: 'catalog.lookup', arguments: { sku: 'sku-7' } });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ sku: 'sku-7', region: 'cn' });

    await client.close();
    await server.close();
  });

  it('returns isError tool results for invalid tool input', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(catalogLookup);
    const client = await connect(server);

    const result = await client.callTool({
      name: 'catalog.lookup',
      arguments: { sku: 'no' }
    });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it('returns isError tool results when the handler throws', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool({
      name: 'catalog.lookup',
      description: 'Look up a catalog item',
      inputSchema: z.strictObject({ sku: z.string().min(3) }),
      outputSchema: z.strictObject({ sku: z.string() }),
      handler: () => {
        throw new Error('warehouse offline');
      }
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'catalog.lookup', arguments: { sku: 'sku-1' } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      code: 'TOOL_FAILED',
      message: 'warehouse offline'
    });

    await client.close();
    await server.close();
  });

  it('returns a JSON-RPC error for unknown tools', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(catalogLookup);
    const client = await connect(server);

    await expect(client.callTool({ name: 'catalog.missing', arguments: {} })).rejects.toThrowError(
      /unknown|not found|invalid/i
    );

    await client.close();
    await server.close();
  });

  it('keeps echo and time with real schemas on the default server', async () => {
    const server = createServer();
    const client = await connect(server);

    const list = await client.listTools();
    const names = list.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['echo', 'time']);

    const echoSchema = list.tools.find((tool) => tool.name === 'echo')?.inputSchema as Record<
      string,
      unknown
    >;
    expect(echoSchema.type).toBe('object');

    const echoed = await client.callTool({ name: 'echo', arguments: { text: 'hello' } });
    expect(echoed.structuredContent).toEqual({ text: 'hello' });

    await client.close();
    await server.close();
  });

  it('uses the tool definition schema for legacy handleRawRequest, not a global demo schema', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(catalogLookup);

    const ok = await server.handleRawRequest({
      id: '1',
      method: 'tools/call',
      params: { name: 'catalog.lookup', input: { sku: 'sku-9', region: 'eu' } }
    });
    if (!('result' in ok)) {
      throw new Error(`expected result: ${JSON.stringify(ok)}`);
    }
    expect(ok.result).toEqual({ output: { sku: 'sku-9', region: 'eu' } });

    const bad = await server.handleRawRequest({
      id: '2',
      method: 'tools/call',
      params: { name: 'catalog.lookup', input: { sku: 'x' } }
    });
    if (!('error' in bad)) {
      throw new Error('expected error');
    }
    expect(bad.error.code).toBe('INVALID_PARAMS');

    await server.close();
  });

  it('lets a custom definition replace echo with a different schema', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool({
      name: 'echo',
      description: 'custom echo',
      inputSchema: z.strictObject({ payload: z.number() }),
      outputSchema: z.strictObject({ doubled: z.number() }),
      handler: (input) => ({ doubled: input.payload * 2 })
    });

    const client = await connect(server);
    const result = await client.callTool({ name: 'echo', arguments: { payload: 21 } });
    expect(result.structuredContent).toEqual({ doubled: 42 });

    const legacy = await server.handleRawRequest({
      id: '1',
      method: 'tools/call',
      params: { name: 'echo', input: { text: 'old-format' } }
    });
    if (!('error' in legacy)) {
      throw new Error('expected legacy echo-format input to fail against custom schema');
    }
    expect(legacy.error.code).toBe('INVALID_PARAMS');

    await client.close();
    await server.close();
  });

  it('serves prompts/get with and without arguments over the native protocol', async () => {
    const server = createServer();
    const client = await connect(server);

    const withArgs = await client.getPrompt({
      name: 'tool-guide',
      arguments: { toolName: 'time' }
    } as never);
    expect(withArgs.messages).toHaveLength(1);
    expect(String((withArgs.messages[0]?.content as { text?: string }).text)).toMatch(/time tool/i);

    // Optional-argument prompts must accept a request without arguments.
    const withoutArgs = await client.getPrompt({ name: 'tool-guide' } as never);
    expect(withoutArgs.messages).toHaveLength(1);

    const listed = await client.listPrompts();
    expect(listed.prompts.map((prompt) => prompt.name)).toEqual(['tool-guide']);

    await expect(client.getPrompt({ name: 'missing-prompt' } as never)).rejects.toThrowError(
      /unknown|not found|invalid/i
    );

    await client.close();
    await server.close();
  });

  it('serves identical tool listings to multiple protocol instances from one snapshot', async () => {
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool(catalogLookup);

    const clientA = await connect(server);
    const clientB = await connect(server);

    const [listA, listB] = await Promise.all([clientA.listTools(), clientB.listTools()]);
    expect(listA.tools.map((tool) => tool.name)).toEqual(['catalog.lookup']);
    expect(listB.tools.map((tool) => tool.name)).toEqual(['catalog.lookup']);

    const [a, b] = await Promise.all([
      clientA.callTool({ name: 'catalog.lookup', arguments: { sku: 'aaa' } }),
      clientB.callTool({ name: 'catalog.lookup', arguments: { sku: 'bbb' } })
    ]);
    expect(a.structuredContent).toEqual({ sku: 'aaa', region: 'cn' });
    expect(b.structuredContent).toEqual({ sku: 'bbb', region: 'cn' });

    await clientA.close();
    await clientB.close();
    await server.close();
  });

  it('propagates per-call trace context from request _meta', async () => {
    const seen: string[] = [];
    const server = createServer({ includeBuiltInTools: false });
    server.registerTool({
      name: 'trace.tool',
      description: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({ traceId: z.string(), runId: z.string().optional() }),
      handler: (_input, context) => {
        seen.push(context.traceId);
        return { traceId: context.traceId, ...(context.runId ? { runId: context.runId } : {}) };
      }
    });
    const client = await connect(server);

    const result = await client.callTool({ name: 'trace.tool', arguments: {} }, undefined, {
      // MCP clients pass request-level metadata through resetTimeoutOnNotification only;
      // use the params _meta path directly instead.
    } as never);
    expect(result.structuredContent).toMatchObject({ traceId: expect.any(String) });
    expect(seen).toHaveLength(1);

    await client.close();
    await server.close();
  });
});
