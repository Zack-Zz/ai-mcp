import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CONTEXT_META_KEY } from '@ai-mcp/shared';
import { createServer, defineTool } from '../src/index.js';

type Seen = {
  marker: string;
  traceId: string;
  runId?: string;
  taskId?: string;
  invocationId?: string;
};

async function startTraceServer() {
  const seen: Seen[] = [];
  const server = createServer({ includeBuiltInTools: false });
  server.registerTool(
    defineTool({
      name: 'trace.mirror',
      description: 'mirror context',
      inputSchema: z.strictObject({ marker: z.string() }),
      outputSchema: z.strictObject({
        marker: z.string(),
        traceId: z.string(),
        runId: z.string().optional(),
        taskId: z.string().optional()
      }),
      handler: (input, context) => {
        seen.push({
          marker: input.marker,
          traceId: context.traceId,
          ...(context.runId !== undefined ? { runId: context.runId } : {}),
          ...(context.taskId !== undefined ? { taskId: context.taskId } : {})
        });
        return {
          marker: input.marker,
          traceId: context.traceId,
          ...(context.runId !== undefined ? { runId: context.runId } : {}),
          ...(context.taskId !== undefined ? { taskId: context.taskId } : {})
        };
      }
    })
  );

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'trace-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return { client, server, seen };
}

describe('invocation context propagation', () => {
  it('delivers _meta context to the handler without polluting tool arguments', async () => {
    const { client, server, seen } = await startTraceServer();

    const result = await client.callTool({
      name: 'trace.mirror',
      arguments: { marker: 'with-context' },
      _meta: {
        [CONTEXT_META_KEY]: { traceId: 'trace-explicit', runId: 'run-7', taskId: 'task-9' }
      }
    } as never);

    expect(result.structuredContent).toMatchObject({
      marker: 'with-context',
      traceId: 'trace-explicit',
      runId: 'run-7',
      taskId: 'task-9'
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.traceId).toBe('trace-explicit');

    await client.close();
    await server.close();
  });

  it('generates distinct traces per call and never reuses request ids as trace ids', async () => {
    const { client, server, seen } = await startTraceServer();

    // Both calls go out with JSON-RPC id 1 from fresh clients.
    const first = await startTraceServer();
    const second = await startTraceServer();
    void client;
    void server;

    await first.client.callTool({
      name: 'trace.mirror',
      arguments: { marker: 'a' }
    } as never);
    await second.client.callTool({
      name: 'trace.mirror',
      arguments: { marker: 'b' }
    } as never);

    const traceA = first.seen[0]?.traceId;
    const traceB = second.seen[0]?.traceId;
    expect(traceA).toBeTruthy();
    expect(traceB).toBeTruthy();
    expect(traceA).not.toBe(traceB);

    await first.client.close();
    await second.client.close();
    await first.server.close();
    await second.server.close();
    void seen;
  });

  it('keeps different run/task contexts isolated between calls', async () => {
    const { client, server, seen } = await startTraceServer();

    await client.callTool({
      name: 'trace.mirror',
      arguments: { marker: 'run-1' },
      _meta: { [CONTEXT_META_KEY]: { traceId: 't-1', runId: 'run-one', taskId: 'task-one' } }
    } as never);
    await client.callTool({
      name: 'trace.mirror',
      arguments: { marker: 'run-2' },
      _meta: { [CONTEXT_META_KEY]: { traceId: 't-2', runId: 'run-two', taskId: 'task-two' } }
    } as never);

    expect(seen.map((entry) => [entry.runId, entry.taskId])).toEqual([
      ['run-one', 'task-one'],
      ['run-two', 'task-two']
    ]);

    await client.close();
    await server.close();
  });
});
