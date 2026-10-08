import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { isLegalToolName, type InvocationContext } from '@ai-mcp/shared';
import { defineTool, ToolRegistry } from '../src/tool-registry.js';
import { testInvocationContext } from './test-context.js';

const catalogLookup = defineTool({
  name: 'catalog.lookup',
  description: 'Look up a catalog item by sku',
  inputSchema: z.strictObject({
    sku: z.string().min(3),
    options: z
      .object({
        includeStock: z.boolean().optional(),
        region: z.enum(['cn', 'eu'])
      })
      .optional()
  }),
  outputSchema: z.strictObject({
    sku: z.string(),
    displayName: z.string(),
    region: z.string()
  }),
  handler: async (input) => ({
    sku: input.sku,
    displayName: `item-${input.sku}`,
    region: input.options?.region ?? 'cn'
  })
});

describe('tool registry', () => {
  it('registers arbitrary legal business tool names without enum extension', () => {
    const registry = new ToolRegistry();
    registry.register(catalogLookup);
    const snapshot = registry.freeze();

    expect(snapshot.descriptors.map((tool) => tool.name)).toEqual(['catalog.lookup']);
    const descriptor = snapshot.descriptors[0] as Record<string, unknown>;
    const inputSchema = descriptor.inputSchema as Record<string, unknown>;
    expect(inputSchema.type).toBe('object');
    const properties = inputSchema.properties as Record<string, unknown>;
    expect(properties.sku).toBeDefined();
    expect(inputSchema.additionalProperties).toBe(false);
    expect(descriptor.outputSchema).toBeDefined();
  });

  it('rejects illegal and duplicate names and keeps the registry unchanged', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: 'bad name!',
        description: 'x',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: () => ({})
      })
    ).toThrowError(/tool name/i);
    expect(() =>
      registry.register({
        name: 'a'.repeat(129),
        description: 'x',
        inputSchema: z.object({}),
        outputSchema: z.object({}),
        handler: () => ({})
      })
    ).toThrowError(/tool name/i);

    registry.register(catalogLookup);
    expect(() => registry.register({ ...catalogLookup, handler: catalogLookup.handler })).toThrow(
      /already registered/
    );
    expect(registry.size).toBe(1);
  });

  it('rejects registration after the snapshot is frozen', () => {
    const registry = new ToolRegistry();
    registry.freeze();
    expect(() => registry.register(catalogLookup)).toThrowError(/frozen|started/i);
  });

  it('defaults new tools to the native-json/v1 contract', () => {
    const registry = new ToolRegistry();
    registry.register(catalogLookup);
    const tool = registry.freeze().find('catalog.lookup');
    expect(tool?.contract).toBe('native-json/v1');
  });

  it('rejects unexportable schemas at registration time', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: 'bad.schema',
        description: 'x',
        inputSchema: z.object({ when: z.date() }),
        outputSchema: z.object({}),
        handler: () => ({})
      })
    ).toThrowError(/schema/i);
  });

  it('rejects non-object schema roots', () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.register({
        name: 'bad.root',
        description: 'x',
        inputSchema: z.string(),
        outputSchema: z.object({}),
        handler: () => ({})
      })
    ).toThrowError(/object/i);
  });

  it('enforces the handler/schema type contract at compile time', () => {
    const registry = new ToolRegistry();
    // The next registration must fail typecheck: the handler's declared
    // input type conflicts with inputSchema's inferred type, so the schema
    // property itself stops matching ToolDefinition<TInput, TOutput>.
    registry.register({
      name: 'type.mismatch',
      description: 'compile contract probe',
      // @ts-expect-error handler input type must be inferred from inputSchema
      inputSchema: z.strictObject({ count: z.number() }),
      outputSchema: z.strictObject({ ok: z.boolean() }),
      handler: (input: { wrong: string }) => ({ ok: input.wrong.length > 0 })
    });
    expect(registry.size).toBe(1);
  });
});

describe('registered tool invoke closure', () => {
  it('parses input with the tool schema, runs the handler and validates output', async () => {
    const registry = new ToolRegistry();
    registry.register(catalogLookup);
    const tool = registry.freeze().find('catalog.lookup');
    if (!tool) {
      throw new Error('tool missing');
    }

    const outcome = await tool.invoke(
      { sku: 'sku-001', options: { region: 'eu' } },
      testInvocationContext()
    );

    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.result.isError).toBe(false);
      expect(outcome.result.structuredContent).toEqual({
        sku: 'sku-001',
        displayName: 'item-sku-001',
        region: 'eu'
      });
      expect(outcome.result.content[0]).toMatchObject({ type: 'text' });
    }
  });

  it('does not execute the handler when input violates the tool schema', async () => {
    const handler = vi.fn(async () => ({ sku: 'x', displayName: 'y', region: 'z' }));
    const registry = new ToolRegistry();
    registry.register({
      name: 'catalog.lookup',
      description: 'x',
      inputSchema: z.strictObject({ sku: z.string().min(3) }),
      outputSchema: z.strictObject({ sku: z.string() }),
      handler
    });
    const tool = registry.freeze().find('catalog.lookup');
    if (!tool) {
      throw new Error('tool missing');
    }

    const outcome = await tool.invoke({ sku: 'a' }, testInvocationContext());
    expect(handler).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('failure');
    if (outcome.kind === 'failure') {
      expect(outcome.fault.category).toBe('invalid_params');
      expect(outcome.fault.executionDisposition).toBe('not_started');
    }
  });

  it('reports handler throw as tool_failure with completed disposition', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'boom.tool',
      description: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: () => {
        throw new Error('business failure');
      }
    });
    const tool = registry.freeze().find('boom.tool');
    if (!tool) {
      throw new Error('tool missing');
    }

    const outcome = await tool.invoke({}, testInvocationContext());
    expect(outcome.kind).toBe('failure');
    if (outcome.kind === 'failure') {
      expect(outcome.fault.category).toBe('tool_failure');
      expect(outcome.fault.message).toBe('business failure');
      expect(outcome.fault.executionDisposition).toBe('completed');
    }
  });

  it('rejects outputs violating the declared output schema', async () => {
    // Simulates a handler whose runtime return breaks its declared contract;
    // the untrusted value comes from parsed JSON, not a local literal.
    const misleadingOutput = JSON.parse('{"wrong": true}') as { expected: string };
    const registry = new ToolRegistry();
    registry.register({
      name: 'bad.output',
      description: 'x',
      inputSchema: z.object({}),
      outputSchema: z.strictObject({ expected: z.string() }),
      handler: () => misleadingOutput
    });
    const tool = registry.freeze().find('bad.output');
    if (!tool) {
      throw new Error('tool missing');
    }

    const outcome = await tool.invoke({}, testInvocationContext());
    expect(outcome.kind).toBe('failure');
    if (outcome.kind === 'failure') {
      expect(outcome.fault.message).toMatch(/invalid output/i);
      expect(outcome.fault.category).toBe('invalid_result');
    }
  });

  it('rejects non-json-serializable outputs even when the schema is loose', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'not.json',
      description: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({ value: z.unknown() }),
      handler: () => ({ value: new Date(0) })
    });
    const tool = registry.freeze().find('not.json');
    if (!tool) {
      throw new Error('tool missing');
    }

    const outcome = await tool.invoke({}, testInvocationContext());
    expect(outcome.kind).toBe('failure');
    if (outcome.kind === 'failure') {
      expect(outcome.fault.message).toMatch(/json/i);
    }
  });

  it('keeps per-invocation context isolated across concurrent calls', async () => {
    let active = 0;
    let peak = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: 'slow.tool',
      description: 'x',
      inputSchema: z.object({ marker: z.string() }),
      outputSchema: z.object({ marker: z.string(), traceId: z.string() }),
      handler: async (input, context) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { marker: input.marker, traceId: context.traceId };
      }
    });
    const tool = registry.freeze().find('slow.tool');
    if (!tool) {
      throw new Error('tool missing');
    }

    const contexts: InvocationContext[] = ['a', 'b', 'c'].map((marker, index) =>
      testInvocationContext({ invocationId: `inv-${index}`, traceId: `trace-${marker}` })
    );
    const outcomes = await Promise.all([
      tool.invoke({ marker: 'a' }, contexts[0] as InvocationContext),
      tool.invoke({ marker: 'b' }, contexts[1] as InvocationContext),
      tool.invoke({ marker: 'c' }, contexts[2] as InvocationContext)
    ]);

    expect(peak).toBe(3);
    for (const [index, outcome] of outcomes.entries()) {
      expect(outcome.kind).toBe('success');
      if (outcome.kind === 'success') {
        const sc = outcome.result.structuredContent as { marker: string; traceId: string };
        expect(sc.traceId).toBe(`trace-${sc.marker}`);
        expect(contexts[index]?.traceId).toBeTruthy();
      }
    }
  });

  it('exposes the shared name rule so the compile contract stays testable', () => {
    expect(isLegalToolName('catalog.lookup')).toBe(true);
  });
});
