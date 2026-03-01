import type { RpcResponse } from '@ai-mcp/shared';

export type RpcTransport = {
  request(payload: unknown, timeoutMs: number): Promise<RpcResponse>;
  close(): Promise<void>;
};
