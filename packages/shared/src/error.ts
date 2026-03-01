import { randomUUID } from 'node:crypto';
import { ErrorCode, McpErrorShape } from './types.js';

export class McpError extends Error {
  public readonly code: ErrorCode;
  public readonly traceId: string;
  public readonly details?: unknown;

  public constructor(code: ErrorCode, message: string, traceId?: string, details?: unknown) {
    super(message);
    this.name = 'McpError';
    this.code = code;
    this.traceId = traceId ?? randomUUID();
    this.details = details;
  }

  public toShape(): McpErrorShape {
    return {
      code: this.code,
      message: this.message,
      traceId: this.traceId,
      details: this.details
    };
  }
}

export function createTraceId(): string {
  return randomUUID();
}

export function normalizeError(error: unknown, traceId = createTraceId()): McpErrorShape {
  if (error instanceof McpError) {
    return error.toShape();
  }
  if (error instanceof Error) {
    return {
      code: 'INTERNAL',
      message: error.message,
      traceId
    };
  }
  return {
    code: 'INTERNAL',
    message: 'Unknown error',
    traceId,
    details: error
  };
}
