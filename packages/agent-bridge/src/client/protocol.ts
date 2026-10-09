import { BridgeError } from '../contracts/errors.js';
import type { OperationReply } from '../contracts/types.js';

export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export const OPERATIONS = new Set([
  'engine.list',
  'preflight',
  'task.start',
  'task.get',
  'task.list',
  'task.watch',
  'task.continue',
  'task.cancel',
  'artifact.list',
  'artifact.read',
  'runtime.handshake',
  'runtime.stop'
]);
export type RpcRequest = {
  apiVersion: 'agent-bridge/v1';
  configHash: string;
  callerRef: string;
  bindingHash: string;
  challenge: string;
  issuedAtMs: number;
  proof: string;
  operation: string;
  args: unknown;
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BridgeError('INVALID_ARGUMENT', 'Expected a JSON object');
  return value as Record<string, unknown>;
}
export function parseRequest(value: unknown): RpcRequest {
  const request = object(value);
  if (
    Object.keys(request).some(
      (key) =>
        ![
          'apiVersion',
          'configHash',
          'callerRef',
          'bindingHash',
          'challenge',
          'issuedAtMs',
          'proof',
          'operation',
          'args'
        ].includes(key)
    ) ||
    request.apiVersion !== 'agent-bridge/v1' ||
    typeof request.configHash !== 'string' ||
    typeof request.callerRef !== 'string' ||
    typeof request.bindingHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.bindingHash) ||
    typeof request.challenge !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.challenge) ||
    typeof request.issuedAtMs !== 'number' ||
    !Number.isSafeInteger(request.issuedAtMs) ||
    typeof request.proof !== 'string' ||
    !/^[a-f0-9]{64}$/.test(request.proof) ||
    typeof request.operation !== 'string' ||
    !OPERATIONS.has(request.operation)
  )
    throw new BridgeError('INVALID_ARGUMENT', 'Unsupported control request');
  return request as RpcRequest;
}
export function requestId(args: unknown): string | undefined {
  return args &&
    typeof args === 'object' &&
    'requestId' in args &&
    typeof args.requestId === 'string'
    ? args.requestId
    : undefined;
}
export function errorReply(operation: string, error: unknown, id?: string): OperationReply {
  const failure =
    error instanceof BridgeError
      ? error
      : new BridgeError('INTERNAL', 'Unexpected Bridge control failure', 'unknown');
  return {
    apiVersion: 'agent-bridge/v1',
    operation,
    ...(id ? { requestId: id } : {}),
    error: {
      code: failure.code,
      message: failure.message,
      executionDisposition: failure.executionDisposition,
      ...(failure.details ? { details: failure.details } : {})
    }
  };
}
export function unwrapReply(value: unknown, operation: string, id?: string): unknown {
  const reply = object(value);
  if (
    reply.apiVersion !== 'agent-bridge/v1' ||
    reply.operation !== operation ||
    (id && reply.requestId !== id) ||
    'data' in reply === 'error' in reply
  )
    throw new BridgeError('PROTOCOL_ERROR', 'Invalid or mismatched control response', 'unknown');
  if ('error' in reply) {
    const error = object(reply.error);
    if (
      typeof error.code !== 'string' ||
      typeof error.message !== 'string' ||
      !['unknown', 'completed', 'not_started'].includes(String(error.executionDisposition))
    )
      throw new BridgeError('PROTOCOL_ERROR', 'Malformed control error', 'unknown');
    throw new BridgeError(
      error.code,
      error.message.startsWith(`${error.code}: `)
        ? error.message.slice(error.code.length + 2)
        : error.message,
      error.executionDisposition as 'unknown' | 'completed' | 'not_started',
      error.details === undefined ? undefined : object(error.details)
    );
  }
  return reply.data;
}
