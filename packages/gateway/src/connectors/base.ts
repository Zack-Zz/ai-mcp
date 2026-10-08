import type {
  ErrorCategory,
  NativeToolResult,
  StandardToolResult,
  ToolDescriptor
} from '@ai-mcp/shared';
import type { ToolCapabilityMetadata } from '../types.js';
import { awaitWithSignal } from '@ai-mcp/shared';

/** One caller budget covers connection waits, discovery and execution. */
export async function withConnectorDeadline<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  invoke: (signal: AbortSignal, remainingMs: () => number) => Promise<T>
): Promise<T> {
  const deadline = new AbortController();
  const signal = AbortSignal.any([deadline.signal, ...(callerSignal ? [callerSignal] : [])]);
  const deadlineAt = Date.now() + timeoutMs;
  const timer = setTimeout(
    () => deadline.abort(new DOMException('Downstream call deadline exceeded', 'TimeoutError')),
    timeoutMs
  );
  try {
    signal.throwIfAborted();
    return await awaitWithSignal(
      invoke(signal, () => Math.max(1, deadlineAt - Date.now())),
      signal
    );
  } catch (error) {
    if (signal.aborted)
      throw new DownstreamConnectorError(
        deadline.signal.aborted ? 'backend_timeout' : 'cancelled',
        deadline.signal.aborted ? 'Downstream call deadline exceeded' : 'Downstream call cancelled'
      );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type BackendTool = {
  name: string;
  description: string;
  /** Full downstream descriptor, kept verbatim by the connector. */
  descriptor: ToolDescriptor;
  metadata?: Partial<ToolCapabilityMetadata>;
};

export type ConnectorErrorCategory =
  | 'backend_timeout'
  | 'backend_unavailable'
  | 'invalid_result'
  | 'invalid_request'
  | 'cancelled'
  | 'rate_limited'
  | 'policy_denied'
  | 'backend_error';

export class DownstreamConnectorError extends Error {
  public constructor(
    public readonly category: ConnectorErrorCategory,
    message: string,
    public readonly details?: unknown,
    public readonly permanent = false
  ) {
    super(message);
    this.name = 'DownstreamConnectorError';
  }
}

export type CallContextOptions = Readonly<{
  traceId?: string;
  runId?: string;
  taskId?: string;
  resultContract?: import('@ai-mcp/shared').ResultContract;
}>;

export type DownstreamToolCallResult = {
  durationMs: number;
  /** StandardToolResult compatibility projection for legacy consumers. */
  output: StandardToolResult;
  /** Full native semantic result; error flags and content stay intact. */
  native: NativeToolResult;
};

export type DownstreamConnector = {
  listTools(): Promise<BackendTool[]>;
  callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: CallContextOptions
  ): Promise<DownstreamToolCallResult>;
  close(): Promise<void>;
};

const CLIENT_CATEGORY_MAP: Readonly<Record<string, ConnectorErrorCategory>> = {
  backend_timeout: 'backend_timeout',
  backend_unavailable: 'backend_unavailable',
  invalid_result: 'invalid_result',
  invalid_request: 'invalid_request',
  invalid_params: 'invalid_request',
  cancelled: 'cancelled',
  rate_limited: 'rate_limited',
  policy_denied: 'policy_denied',
  internal: 'backend_error',
  tool_failure: 'backend_error',
  audit_unavailable: 'backend_error',
  unsupported_capability: 'backend_error'
};

export function connectorCategoryFor(category: ErrorCategory): ConnectorErrorCategory {
  return CLIENT_CATEGORY_MAP[category] ?? 'backend_error';
}
