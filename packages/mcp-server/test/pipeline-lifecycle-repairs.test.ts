import { expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each(['legacy', 'native'] as const)(
  '%s budget expires during middleware before execution and forbids a later handler start',
  async (entry) => {
    const blocked = gate();
    let calls = 0;
    const owner = createServer({ includeBuiltInTools: false, callTimeoutMs: 20 });
    owner.use(async (_ctx, next) => {
      await blocked.promise;
      await next();
    });
    owner.registerTool({
      name: 'probe',
      description: '',
      inputSchema: z.object({}),
      outputSchema: z.object({ done: z.boolean() }),
      handler: () => {
        calls++;
        return { done: true };
      }
    });
    const client = new Client({ name: 'deadline', version: '1' });
    if (entry === 'native') {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await owner.connect(b);
      await client.connect(a);
    }
    const pending =
      entry === 'legacy'
        ? owner.handleRawRequest({
            id: '1',
            method: 'tools/call',
            params: { name: 'probe', input: {} }
          })
        : client.callTool({ name: 'probe', arguments: {} }).catch((error: unknown) => error);
    try {
      const result = await Promise.race([
        pending,
        new Promise<string>((r) => setTimeout(() => r('hung'), 250))
      ]);
      expect(result).toMatchObject(
        entry === 'legacy'
          ? { error: { code: 'TIMEOUT' } }
          : { data: { category: 'backend_timeout', executionDisposition: 'not_started' } }
      );
      blocked.release();
      await new Promise<void>((r) => setImmediate(r));
      expect(calls).toBe(0);
    } finally {
      blocked.release();
      await pending;
      await client.close();
      await owner.close();
    }
  }
);

it.each(['legacy', 'native'] as const)(
  '%s budget includes middleware cleanup after business execution',
  async (entry) => {
    const blocked = gate();
    let calls = 0;
    const owner = createServer({ includeBuiltInTools: false, callTimeoutMs: 20 });
    owner.use(async (_ctx, next) => {
      await next();
      await blocked.promise;
    });
    owner.registerTool({
      name: 'probe',
      description: '',
      inputSchema: z.object({}),
      outputSchema: z.object({ done: z.boolean() }),
      handler: () => {
        calls++;
        return { done: true };
      }
    });
    const client = new Client({ name: 'deadline', version: '1' });
    if (entry === 'native') {
      const [a, b] = InMemoryTransport.createLinkedPair();
      await owner.connect(b);
      await client.connect(a);
    }
    const pending =
      entry === 'legacy'
        ? owner.handleRawRequest({
            id: '1',
            method: 'tools/call',
            params: { name: 'probe', input: {} }
          })
        : client.callTool({ name: 'probe', arguments: {} }).catch((error: unknown) => error);
    try {
      const result = await Promise.race([
        pending,
        new Promise<string>((r) => setTimeout(() => r('hung'), 250))
      ]);
      expect(result).toMatchObject(
        entry === 'legacy'
          ? { error: { code: 'TIMEOUT' } }
          : { data: { category: 'backend_timeout', executionDisposition: 'completed' } }
      );
      expect(calls).toBe(1);
    } finally {
      blocked.release();
      await pending;
      await client.close();
      await owner.close();
    }
  }
);

it('service close cancels a legacy invocation and prevents delayed middleware starting its tool', async () => {
  const blocked = gate();
  const entered = gate();
  let calls = 0;
  const owner = createServer({ includeBuiltInTools: false });
  owner.use(async (_ctx, next) => {
    entered.release();
    await blocked.promise;
    await next();
  });
  owner.registerTool({
    name: 'probe',
    description: '',
    inputSchema: z.object({}),
    outputSchema: z.object({ done: z.boolean() }),
    handler: () => {
      calls++;
      return { done: true };
    }
  });
  const pending = owner.handleRawRequest({
    id: '1',
    method: 'tools/call',
    params: { name: 'probe', input: {} }
  });
  await entered.promise;
  await owner.close();
  try {
    expect(
      await Promise.race([pending, new Promise<string>((r) => setTimeout(() => r('hung'), 250))])
    ).toMatchObject({ error: { code: 'TIMEOUT' } });
    blocked.release();
    await new Promise<void>((r) => setImmediate(r));
    expect(calls).toBe(0);
  } finally {
    blocked.release();
    await pending;
  }
});
