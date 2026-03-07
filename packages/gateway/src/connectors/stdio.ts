import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DownstreamConnector } from './base.js';
import { extractToolOutput, normalizeConnectorError, toStandardToolResult } from './result.js';

type SdkTransport = Parameters<Client['connect']>[0];

export type StdioConnectorOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};

export class StdioConnector implements DownstreamConnector {
  private readonly client: Client;
  private connectPromise?: Promise<void>;
  private readonly timeoutMs: number;

  public constructor(private readonly options: StdioConnectorOptions) {
    this.timeoutMs = options.timeoutMs ?? 30000;
    this.client = new Client({
      name: 'ai-mcp-gateway-stdio-connector',
      version: '0.1.0'
    });
  }

  public async listTools(): Promise<{ name: string; description: string }[]> {
    await this.ensureConnected();
    const response = await this.client.listTools(undefined, { timeout: this.timeoutMs });

    return response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? ''
    }));
  }

  public async callTool(name: string, args: unknown, signal?: AbortSignal) {
    const start = Date.now();
    await this.ensureConnected();

    try {
      const result = await this.client.callTool(
        {
          name,
          arguments: (args ?? {}) as Record<string, unknown>
        },
        undefined,
        {
          timeout: this.timeoutMs,
          ...(signal ? { signal } : {})
        }
      );

      const output = toStandardToolResult(extractToolOutput(result));
      return {
        durationMs: Date.now() - start,
        output
      };
    } catch (error) {
      throw normalizeConnectorError(error);
    }
  }

  public async close(): Promise<void> {
    await this.client.close();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      const transport = new StdioClientTransport({
        command: this.options.command,
        ...(this.options.args ? { args: this.options.args } : {}),
        ...(this.options.env ? { env: this.options.env } : {}),
        ...(this.options.cwd ? { cwd: this.options.cwd } : {})
      }) as SdkTransport;
      this.connectPromise = this.client.connect(transport);
    }

    await this.connectPromise;
  }
}
