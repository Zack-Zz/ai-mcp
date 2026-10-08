import { expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpClient } from '../../mcp-client/src/client.js';
import { createServer } from '../src/server.js';
import { ToolRegistry } from '../src/tool-registry.js';
import { testInvocationContext } from './test-context.js';

it('never starts the handler when its deadline expires during input validation', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  let calls = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: 'validate',
    description: '',
    inputSchema: z.object({}).refine(async () => {
      await blocked;
      return true;
    }),
    outputSchema: z.object({ done: z.boolean() }),
    handler: () => {
      calls++;
      return { done: true };
    }
  });
  const tool = registry.freeze().find('validate');
  if (!tool) throw new Error('missing tool');
  const result = await tool.invoke({}, testInvocationContext({ deadlineAt: Date.now() + 20 }));
  release();
  await new Promise<void>((r) => setImmediate(r));
  expect(result).toMatchObject({ kind: 'failure', fault: { executionDisposition: 'not_started' } });
  expect(calls).toBe(0);
});

it('reports declared standard failures to both the protocol client and audit middleware', async () => {
  const outcomes: unknown[] = [];
  const server = createServer({ includeBuiltInTools: false });
  server.use(async (ctx, next) => {
    await next();
    outcomes.push(ctx.outcome);
  });
  server.registerTool({
    name: 'failure',
    description: 'failure',
    resultContract: 'standard/v1',
    inputSchema: z.object({}),
    outputSchema: z.strictObject({ ok: z.boolean(), code: z.string(), message: z.string() }),
    handler: () => ({ ok: false, code: 'DENIED', message: 'denied' })
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  try {
    const result = await client.callTool({ name: 'failure', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toEqual({ ok: false, code: 'DENIED', message: 'denied' });
    expect(outcomes).toEqual(['tool_error']);
  } finally {
    await client.close();
    await server.close();
  }
});

it('returns a classified deadline without waiting for a handler that ignores cancellation', async () => {
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const server = createServer({ includeBuiltInTools: false, callTimeoutMs: 20 });
  server.registerTool({
    name: 'blocked',
    description: 'blocked',
    inputSchema: z.object({}),
    outputSchema: z.object({ done: z.boolean() }),
    handler: async () => {
      await blocked;
      return { done: true };
    }
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  const call = client.callTool({ name: 'blocked', arguments: {} });
  try {
    const result = await Promise.race([
      call.then(
        () => 'success',
        (error: unknown) => error
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve('hung'), 300))
    ]);
    expect(result).toMatchObject({
      data: { category: 'backend_timeout', executionDisposition: 'unknown' }
    });
  } finally {
    release();
    await call.catch(() => undefined);
    await client.close();
    await server.close();
  }
});

it('generates a trace while preserving caller run and task identities', async () => {
  const server = createServer({ includeBuiltInTools: false });
  server.registerTool({
    name: 'context',
    description: 'context',
    inputSchema: z.object({}),
    outputSchema: z.object({
      traceId: z.string(),
      runId: z.string().optional(),
      taskId: z.string().optional()
    }),
    handler: (_input, ctx) => ({
      traceId: ctx.traceId,
      ...(ctx.runId ? { runId: ctx.runId } : {}),
      ...(ctx.taskId ? { taskId: ctx.taskId } : {})
    })
  });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new McpClient(a);
  await client.connect();
  try {
    expect(
      (await client.callToolResult('context', {}, { context: { runId: 'run', taskId: 'task' } }))
        .structuredContent
    ).toMatchObject({ traceId: expect.any(String), runId: 'run', taskId: 'task' });
  } finally {
    await client.close();
    await server.close();
  }
});
