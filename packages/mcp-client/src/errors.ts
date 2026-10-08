import { McpError as SdkMcpError } from '@modelcontextprotocol/sdk/types.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ZodError } from 'zod';
import {
  isJsonObject,
  errorCategorySchema,
  type ErrorCategory,
  type JsonObject
} from '@ai-mcp/shared';

/**
 * Project-level client error: category/classification first, message text
 * only for presentation. Transport failures that make the current transport
 * unusable are marked permanent so callers do not retry on a dead pipe.
 */
export class McpClientError extends Error {
  public constructor(
    public readonly category: ErrorCategory,
    public readonly projectCode: string,
    message: string,
    public readonly details?: JsonObject,
    public readonly permanent = false
  ) {
    super(message);
    this.name = 'McpClientError';
  }
}

const GATEWAY_CODE_CATEGORIES: Record<number, { category: ErrorCategory; projectCode: string }> = {
  [-32001]: { category: 'backend_timeout', projectCode: 'BACKEND_TIMEOUT' },
  [-32010]: { category: 'rate_limited', projectCode: 'RATE_LIMITED' },
  [-32020]: { category: 'policy_denied', projectCode: 'POLICY_DENIED' },
  [-32030]: { category: 'backend_unavailable', projectCode: 'BACKEND_UNAVAILABLE' },
  [-32040]: { category: 'backend_timeout', projectCode: 'BACKEND_TIMEOUT' }
};

function messageText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPermanentTransportFailure(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('subprocess exited') ||
    normalized.includes('transport closed') ||
    normalized.includes('connection closed')
  );
}

/**
 * Classification order: typed signals first (our error passthrough, SDK
 * error codes, aborts, schema failures), message text only as the last
 * fallback for unknown errors.
 */
export function classifySdkClientError(
  error: unknown,
  phase: 'connect' | 'request' | 'close'
): McpClientError {
  if (error instanceof McpClientError) {
    return error;
  }

  if (error instanceof StreamableHTTPError) {
    const category: ErrorCategory =
      error.code === 401 || error.code === 403
        ? 'policy_denied'
        : error.code === 429
          ? 'rate_limited'
          : error.code === 404 || (error.code !== undefined && error.code >= 500)
            ? 'backend_unavailable'
            : error.code === -1
              ? 'invalid_result'
              : 'invalid_request';
    const code =
      category === 'backend_unavailable'
        ? 'BACKEND_UNAVAILABLE'
        : category === 'policy_denied'
          ? 'POLICY_DENIED'
          : category === 'rate_limited'
            ? 'RATE_LIMITED'
            : category === 'invalid_result'
              ? 'INVALID_RESULT'
              : 'INVALID_REQUEST';
    return new McpClientError(
      category,
      code,
      error.message,
      error.code !== undefined ? { httpStatus: error.code } : undefined,
      category === 'backend_unavailable'
    );
  }

  // Node fetch carries the transport cause separately from its generic text.
  const cause = error instanceof Error ? error.cause : undefined;
  const transportCode =
    typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  if (
    typeof transportCode === 'string' &&
    ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EPIPE', 'UND_ERR_SOCKET'].includes(transportCode)
  ) {
    return new McpClientError(
      'backend_unavailable',
      'BACKEND_UNAVAILABLE',
      messageText(error),
      { transportCode },
      true
    );
  }

  if (error instanceof SdkMcpError) {
    if (isJsonObject(error.data)) {
      const category = errorCategorySchema.safeParse(error.data.category);
      if (category.success && typeof error.data.projectCode === 'string') {
        return new McpClientError(category.data, error.data.projectCode, error.message, {
          jsonRpcCode: error.code,
          data: error.data
        });
      }
    }
    const mapped = GATEWAY_CODE_CATEGORIES[error.code];
    if (mapped) {
      return new McpClientError(
        mapped.category,
        mapped.projectCode,
        error.message,
        { jsonRpcCode: error.code, ...(error.data ? { data: error.data as JsonObject } : {}) },
        false
      );
    }
    // The SDK surfaces transport shutdown (e.g. a stdio subprocess exiting
    // during the handshake) as -32000 "Connection closed".
    if (error.code === -32000 && /connection closed|transport/i.test(error.message)) {
      return new McpClientError(
        'backend_unavailable',
        'BACKEND_UNAVAILABLE',
        error.message,
        { jsonRpcCode: error.code },
        true
      );
    }
    if (error.code === -32603) {
      return new McpClientError('internal', 'INTERNAL', error.message, {
        jsonRpcCode: error.code,
        ...(error.data ? { data: error.data as JsonObject } : {})
      });
    }
    return new McpClientError('invalid_request', 'INVALID_REQUEST', error.message, {
      jsonRpcCode: error.code,
      ...(error.data ? { data: error.data as JsonObject } : {})
    });
  }

  if (error instanceof ZodError) {
    return new McpClientError(
      'invalid_result',
      'INVALID_RESULT',
      `Downstream returned a result that violates the protocol schema: ${error.message}`,
      {
        issues: error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message
        }))
      }
    );
  }

  const message = messageText(error);
  const name = error instanceof Error ? error.name : '';

  if (name === 'AbortError' || name === 'TimeoutError' || name === 'DOMException') {
    const cancelled = phase === 'request';
    return new McpClientError(
      cancelled ? 'cancelled' : 'backend_timeout',
      cancelled ? 'CANCELLED' : 'BACKEND_TIMEOUT',
      message,
      undefined,
      false
    );
  }

  // Last-resort text fallback only for genuinely unknown errors.
  const normalized = message.toLowerCase();
  if (normalized.includes('fetch failed')) {
    return new McpClientError(
      'backend_unavailable',
      'BACKEND_UNAVAILABLE',
      message,
      undefined,
      true
    );
  }
  if (phase === 'connect') {
    if (
      normalized.includes('connect') ||
      normalized.includes('fetch failed') ||
      normalized.includes('econnrefused') ||
      normalized.includes('subprocess exited') ||
      normalized.includes('transport closed') ||
      normalized.includes('connection closed') ||
      normalized.includes('socket closed') ||
      normalized.includes('not found')
    ) {
      return new McpClientError(
        'backend_unavailable',
        'BACKEND_UNAVAILABLE',
        message,
        undefined,
        isPermanentTransportFailure(normalized)
      );
    }
  }
  if (normalized.includes('timeout') || normalized.includes('timed out')) {
    return new McpClientError('backend_timeout', 'BACKEND_TIMEOUT', message);
  }
  if (normalized.includes('not connected')) {
    return new McpClientError('backend_unavailable', 'BACKEND_UNAVAILABLE', message);
  }
  if (normalized.includes('abort')) {
    return new McpClientError('cancelled', 'CANCELLED', message);
  }

  return new McpClientError('internal', 'INTERNAL', message, { phase });
}
