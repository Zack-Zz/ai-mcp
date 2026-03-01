import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { DownstreamConnector } from './base.js';

type SdkTransport = Parameters<Client['connect']>[0];

export type StdioConnectorOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
};

function extractToolOutput(result: unknown): unknown {
  if (typeof result === 'object' && result !== null) {
    const maybeStructured = (result as { structuredContent?: unknown }).structuredContent;
    if (maybeStructured !== undefined) {
      return maybeStructured;
    }

    const maybeContent = (result as { content?: unknown }).content;
    if (Array.isArray(maybeContent)) {
      const textBlock = maybeContent.find(
        (item): item is { type: 'text'; text: string } =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
      );

      if (textBlock) {
        try {
          return JSON.parse(textBlock.text);
        } catch {
          return textBlock.text;
        }
      }
    }
  }

  throw new Error('Invalid downstream tool result');
}

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

  public async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    await this.ensureConnected();
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

    return extractToolOutput(result);
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
