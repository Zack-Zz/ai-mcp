import { mcpErrorSchema, type RpcResponse } from '@ai-mcp/shared';
import type { RpcTransport } from './base.js';

export class HttpTransport implements RpcTransport {
  public constructor(private readonly endpoint: string) {}

  public async request(payload: unknown, timeoutMs: number): Promise<RpcResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data = (await response.json()) as RpcResponse;
      if (data.error) {
        mcpErrorSchema.parse(data.error);
      }
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }

  public async close(): Promise<void> {
    return Promise.resolve();
  }
}
