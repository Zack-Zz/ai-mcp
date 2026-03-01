import {
  McpError,
  createTraceId,
  normalizeError,
  type ToolInputMap,
  type ToolName,
  type ToolOutputMap,
  type TransportKind
} from '@ai-mcp/shared';
import { HttpTransport } from './transports/http.js';
import { SseTransport } from './transports/sse.js';
import { StdioTransport } from './transports/stdio.js';
import type { RpcTransport } from './transports/base.js';

export type CreateClientOptions = {
  transport: TransportKind;
  endpoint?: string;
  timeoutMs?: number;
};

export class McpClient {
  private readonly timeoutMs: number;

  public constructor(
    private readonly transport: RpcTransport,
    timeoutMs = 10000
  ) {
    this.timeoutMs = timeoutMs;
  }

  public async listTools(): Promise<{ name: string; description: string }[]> {
    const response = await this.request({
      id: createTraceId(),
      method: 'tools/list'
    });

    if (!response.result || !('tools' in response.result)) {
      throw new Error('Invalid list tools response');
    }

    return response.result.tools;
  }

  public async callTool<TName extends ToolName>(
    name: TName,
    input: ToolInputMap[TName]
  ): Promise<ToolOutputMap[TName]> {
    const response = await this.request({
      id: createTraceId(),
      method: 'tools/call',
      params: {
        name,
        input
      }
    });

    if (!response.result || !('output' in response.result)) {
      throw new Error('Invalid tool call response');
    }

    return response.result.output as ToolOutputMap[TName];
  }

  public async close(): Promise<void> {
    await this.transport.close();
  }

  private async request(payload: unknown): Promise<Awaited<ReturnType<RpcTransport['request']>>> {
    try {
      const response = await this.transport.request(payload, this.timeoutMs);
      if (response.error) {
        throw new McpError(
          response.error.code,
          response.error.message,
          response.error.traceId,
          response.error.details
        );
      }
      return response;
    } catch (error) {
      const normalized = normalizeError(error);
      throw new McpError(
        normalized.code,
        normalized.message,
        normalized.traceId,
        normalized.details
      );
    }
  }
}

export function createClient(options: CreateClientOptions): McpClient {
  if (!options.endpoint && options.transport !== 'stdio') {
    throw new Error('endpoint is required for http and sse transport');
  }

  if (!options.endpoint && options.transport === 'stdio') {
    throw new Error('endpoint command is required for stdio transport');
  }

  switch (options.transport) {
    case 'http':
      return new McpClient(new HttpTransport(options.endpoint!), options.timeoutMs ?? 10000);
    case 'sse':
      return new McpClient(new SseTransport(options.endpoint!), options.timeoutMs ?? 10000);
    case 'stdio':
      return new McpClient(new StdioTransport(options.endpoint!), options.timeoutMs ?? 10000);
    default:
      throw new Error(`Unsupported transport: ${options.transport}`);
  }
}
