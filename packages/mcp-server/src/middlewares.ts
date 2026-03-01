import { McpError, type ErrorCode } from '@ai-mcp/shared';
import type { Middleware } from './types.js';

export function authMiddleware(enabled = false): Middleware {
  return async (ctx, next) => {
    if (!enabled) {
      await next();
      return;
    }
    throw new McpError('UNAUTHORIZED', `Unauthorized request for ${ctx.method}`, ctx.traceId);
  };
}

export function rateLimitMiddleware(maxRequests = Number.POSITIVE_INFINITY): Middleware {
  let count = 0;
  return async (ctx, next) => {
    count += 1;
    if (count > maxRequests) {
      throw new McpError('TIMEOUT', `Rate limit exceeded for ${ctx.method}`, ctx.traceId);
    }
    await next();
  };
}

export function auditMiddleware(
  logger: (event: {
    traceId: string;
    method: string;
    outcome: 'ok' | 'error';
    errorCode?: ErrorCode;
  }) => void
): Middleware {
  return async (ctx, next) => {
    try {
      await next();
      logger({ traceId: ctx.traceId, method: ctx.method, outcome: 'ok' });
    } catch (error) {
      const errorCode: ErrorCode | undefined = error instanceof McpError ? error.code : undefined;
      logger({
        traceId: ctx.traceId,
        method: ctx.method,
        outcome: 'error',
        ...(errorCode ? { errorCode } : {})
      });
      throw error;
    }
  };
}
