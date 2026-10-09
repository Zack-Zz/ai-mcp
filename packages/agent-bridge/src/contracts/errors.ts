export type Disposition = 'not_started' | 'completed' | 'unknown';
export class BridgeError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly executionDisposition: Disposition = 'not_started',
    public readonly details?: Record<string, unknown>
  ) {
    super(`${code}: ${message}`);
    this.name = 'BridgeError';
  }
}
export function asBridgeError(error: unknown): BridgeError {
  return error instanceof BridgeError
    ? error
    : new BridgeError(
        'INTERNAL',
        error instanceof Error ? error.message : 'Unexpected failure',
        'unknown'
      );
}
