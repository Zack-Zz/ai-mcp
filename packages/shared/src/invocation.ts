import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { JsonObject, JsonValue } from './types.js';

export type ProtocolEra = 'legacy' | 'modern';

export const ERROR_CATEGORIES = [
  'invalid_request',
  'invalid_params',
  'tool_failure',
  'policy_denied',
  'rate_limited',
  'backend_timeout',
  'backend_unavailable',
  'invalid_result',
  'cancelled',
  'audit_unavailable',
  'internal',
  'unsupported_capability'
] as const;

export type ErrorCategory = (typeof ERROR_CATEGORIES)[number];

export const errorCategorySchema = z.enum(ERROR_CATEGORIES);

/** Stable project error codes; the legacy four string codes stay usable. */
export const PROJECT_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_PARAMS',
  'UNAUTHORIZED',
  'TIMEOUT',
  'INTERNAL',
  'TOOL_FAILED',
  'POLICY_DENIED',
  'RATE_LIMITED',
  'BACKEND_TIMEOUT',
  'BACKEND_UNAVAILABLE',
  'INVALID_RESULT',
  'CANCELLED',
  'AUDIT_UNAVAILABLE',
  'UNSUPPORTED_CAPABILITY',
  'SCHEMA_UNSUPPORTED',
  'RESULT_CONTRACT_AMBIGUOUS'
] as const;

export type ProjectErrorCode = (typeof PROJECT_ERROR_CODES)[number];

const CODE_TO_CATEGORY: Readonly<Record<ProjectErrorCode, ErrorCategory>> = {
  INVALID_REQUEST: 'invalid_request',
  INVALID_PARAMS: 'invalid_params',
  UNAUTHORIZED: 'policy_denied',
  TIMEOUT: 'backend_timeout',
  INTERNAL: 'internal',
  TOOL_FAILED: 'tool_failure',
  POLICY_DENIED: 'policy_denied',
  RATE_LIMITED: 'rate_limited',
  BACKEND_TIMEOUT: 'backend_timeout',
  BACKEND_UNAVAILABLE: 'backend_unavailable',
  INVALID_RESULT: 'invalid_result',
  CANCELLED: 'cancelled',
  AUDIT_UNAVAILABLE: 'audit_unavailable',
  UNSUPPORTED_CAPABILITY: 'unsupported_capability',
  SCHEMA_UNSUPPORTED: 'invalid_params',
  RESULT_CONTRACT_AMBIGUOUS: 'invalid_params'
};

export function categoryForCode(code: string): ErrorCategory {
  const category = CODE_TO_CATEGORY[code as ProjectErrorCode];
  if (!category) {
    throw new Error(`Unknown project error code: ${code}`);
  }
  return category;
}

export type ExecutionDisposition = 'not_started' | 'completed' | 'unknown';

export type FaultSource = Readonly<{
  kind: 'local' | 'peer' | 'sdk' | 'transport' | 'audit';
  backendId?: string;
  protocolVersion?: string;
  code?: string | number;
  traceId?: string;
}>;

export type InvocationFault = {
  category: ErrorCategory;
  projectCode: string;
  message: string;
  traceId: string;
  invocationId: string;
  executionDisposition: ExecutionDisposition;
  source?: FaultSource;
  details?: JsonObject;
};

const faultSchema = z.object({
  category: errorCategorySchema,
  projectCode: z.string().min(1),
  message: z.string(),
  traceId: z.string().min(1),
  invocationId: z.string().min(1),
  executionDisposition: z.enum(['not_started', 'completed', 'unknown']),
  source: z
    .object({
      kind: z.enum(['local', 'peer', 'sdk', 'transport', 'audit']),
      backendId: z.string().optional(),
      protocolVersion: z.string().optional(),
      code: z.union([z.string(), z.number()]).optional(),
      traceId: z.string().optional()
    })
    .optional(),
  details: z.record(z.string(), z.unknown()).optional()
});

export function isInvocationFault(value: unknown): value is InvocationFault {
  return faultSchema.safeParse(value).success;
}

export function createFault(input: InvocationFault): InvocationFault {
  if (!isInvocationFault(input)) {
    throw new Error('Invalid invocation fault payload');
  }
  return input;
}

export type InvocationContext = {
  /** Server-generated unique id for this single invocation. */
  invocationId: string;
  /** Propagatable business trace id; generated when the caller has none. */
  traceId: string;
  requestId?: string | number;
  peerEra: ProtocolEra;
  protocolVersion: string;
  mcpSessionId?: string;
  runId?: string;
  taskId?: string;
  deadlineAt: number;
  signal: AbortSignal;
  actor: Readonly<{
    tenantId: string;
    who?: string;
    agent?: string;
  }>;
};

export type InvokeRequest = {
  name: string;
  arguments: JsonObject;
  context: InvocationContext;
};

export type NativeToolResultLike = {
  content: JsonObject[];
  structuredContent?: JsonValue;
  isError: boolean;
  _meta?: JsonObject;
};

export type InvocationOutcome =
  | { kind: 'success'; result: NativeToolResultLike }
  | { kind: 'tool_failure'; result: NativeToolResultLike; fault: InvocationFault }
  | { kind: 'failure'; fault: InvocationFault };

export function createInvocationId(): string {
  return randomUUID();
}

/** Waiter cancellation never replays work or removes another caller's connection. */
export function awaitWithSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Cancelled', 'AbortError'));
    };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    // Always observe the operation even when cancellation already won.
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      }
    );
    if (signal.aborted) aborted();
  });
}
