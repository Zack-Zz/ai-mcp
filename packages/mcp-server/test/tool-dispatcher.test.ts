import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { auditMiddleware } from '../src/middlewares.js';
import { ToolDispatcher } from '../src/tool-dispatcher.js';
import { ToolRegistry } from '../src/tool-registry.js';
import type { Middleware } from '../src/types.js';
import { testInvocationContext } from './test-context.js';

function buildDispatcher(middlewares: Middleware[] = []) {
  const registry = new ToolRegistry();
  registry.register({
    name: 'demo.tool',
    description: 'x',
    inputSchema: z.strictObject({ value: z.number() }),
    outputSchema: z.strictObject({ doubled: z.number() }),
    handler: (input) => ({ doubled: input.value * 2 })
  });
  const snapshot = registry.freeze();
  const dispatcher = new ToolDispatcher(snapshot, middlewares);
  return { dispatcher, registry };
}

describe('tool dispatcher', () => {
  it('fails with an invalid_request fault for unknown tools without running middlewares', async () => {
    const middleware = vi.fn(async (_ctx, next) => {
      await next();
    });
    const { dispatcher } = buildDispatcher([middleware]);

    const outcome = await dispatcher.invoke('missing.tool', {}, testInvocationContext());
    expect(outcome.kind).toBe('failure');
    if (outcome.kind === 'failure') {
      expect(outcome.fault.category).toBe('invalid_request');
      expect(outcome.fault.message).toMatch(/missing.tool/);
    }
    expect(middleware).not.toHaveBeenCalled();
  });

  it('wraps actual validation and execution inside the middleware terminal', async () => {
    const order: string[] = [];
    const { dispatcher } = buildDispatcher([
      async (_ctx, next) => {
        order.push('before');
        await next();
        order.push('after');
      }
    ]);

    const outcome = await dispatcher.invoke('demo.tool', { value: 2 }, testInvocationContext());
    expect(order).toEqual(['before', 'after']);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.result.structuredContent).toEqual({ doubled: 4 });
    }
  });

  it('blocks execution when a middleware short-circuits', async () => {
    const { dispatcher } = buildDispatcher([
      async () => {
        throw new Error('blocked by policy');
      }
    ]);

    await expect(
      dispatcher.invoke('demo.tool', { value: 1 }, testInvocationContext())
    ).rejects.toThrowError('blocked by policy');
  });

  it('records a tool failure outcome after the handler throws', async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: 'failing.tool',
      description: 'x',
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      handler: () => {
        throw new Error('handler exploded');
      }
    });
    const events: { outcome: string; method: string }[] = [];
    const dispatcher = new ToolDispatcher(registry.freeze(), [
      auditMiddleware((event) => {
        events.push({ outcome: event.outcome, method: event.method });
      })
    ]);

    const outcome = await dispatcher.invoke('failing.tool', {}, testInvocationContext());
    expect(outcome.kind).toBe('failure');
    if (outcome.kind === 'failure') {
      expect(outcome.fault.category).toBe('tool_failure');
    }
    expect(events).toEqual([{ outcome: 'error', method: 'tools/call' }]);
  });

  it('records ok only after successful execution', async () => {
    const events: { outcome: string }[] = [];
    const { dispatcher } = buildDispatcher([
      auditMiddleware((event) => {
        events.push({ outcome: event.outcome });
      })
    ]);

    await dispatcher.invoke('demo.tool', { value: 1 }, testInvocationContext());
    expect(events).toEqual([{ outcome: 'ok' }]);
  });

  it('records error for invalid parameters without executing the handler', async () => {
    const events: { outcome: string; errorCode?: string }[] = [];
    const { dispatcher } = buildDispatcher([
      auditMiddleware((event) => {
        events.push({
          outcome: event.outcome,
          ...(event.errorCode ? { errorCode: event.errorCode } : {})
        });
      })
    ]);

    const outcome = await dispatcher.invoke('demo.tool', { value: 'NaN' }, testInvocationContext());
    expect(outcome.kind).toBe('failure');
    expect(events).toEqual([{ outcome: 'error', errorCode: 'INVALID_PARAMS' }]);
  });
});
