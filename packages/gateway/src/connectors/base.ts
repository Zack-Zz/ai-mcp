import type { StandardToolResult } from '@ai-mcp/shared';
import type { ToolCapabilityMetadata } from '../types.js';

export type BackendTool = {
  name: string;
  description: string;
  metadata?: Partial<ToolCapabilityMetadata>;
};

export type ConnectorErrorCategory =
  | 'backend_timeout'
  | 'backend_unavailable'
  | 'invalid_result'
  | 'backend_error';

export class DownstreamConnectorError extends Error {
  public constructor(
    public readonly category: ConnectorErrorCategory,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'DownstreamConnectorError';
  }
}

export type DownstreamToolCallResult = {
  durationMs: number;
  output: StandardToolResult;
};

export type DownstreamConnector = {
  listTools(): Promise<BackendTool[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<DownstreamToolCallResult>;
  close(): Promise<void>;
};
