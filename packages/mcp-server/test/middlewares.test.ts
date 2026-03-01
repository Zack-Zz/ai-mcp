import { describe, expect, it, vi } from 'vitest';
import { authMiddleware, auditMiddleware, rateLimitMiddleware } from '../src/middlewares.js';

describe('server middlewares', () => {
  it('allows request when auth middleware disabled', async () => {
    const middleware = authMiddleware(false);
    const next = vi.fn(async () => undefined);
    await middleware({ traceId: 't1', method: 'tools/list' }, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('blocks request when auth middleware enabled', async () => {
    const middleware = authMiddleware(true);
    await expect(
      middleware({ traceId: 't2', method: 'tools/list' }, async () => undefined)
    ).rejects.toThrowError('Unauthorized request for tools/list');
  });

  it('rate limit middleware rejects after max requests', async () => {
    const middleware = rateLimitMiddleware(1);
    await middleware({ traceId: 't3', method: 'tools/list' }, async () => undefined);
    await expect(
      middleware({ traceId: 't3', method: 'tools/list' }, async () => undefined)
    ).rejects.toThrowError('Rate limit exceeded for tools/list');
  });

  it('audit middleware logs success and error paths', async () => {
    const logger = vi.fn();
    const middleware = auditMiddleware(logger);

    await middleware({ traceId: 't4', method: 'tools/list' }, async () => undefined);
    expect(logger).toHaveBeenCalledWith({ traceId: 't4', method: 'tools/list', outcome: 'ok' });

    await expect(
      middleware({ traceId: 't5', method: 'tools/list' }, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrowError('boom');

    expect(logger).toHaveBeenCalledWith({ traceId: 't5', method: 'tools/list', outcome: 'error' });
  });
});
