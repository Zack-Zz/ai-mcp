import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  type ToolInputMap,
  type ToolName,
  type ToolOutputMap,
  type TransportKind
} from '@ai-mcp/shared';

export type CreateClientOptions = {
  transport: TransportKind;
  endpoint?: string;
  timeoutMs?: number;
};

type SdkTransport = Parameters<SdkClient['connect']>[0];

export class McpClient {
  private readonly timeoutMs: number;
  private readonly sdkClient: SdkClient;
  private connectPromise?: Promise<void>;

  public constructor(
    private readonly transport: SdkTransport,
    timeoutMs = 10000
  ) {
    this.timeoutMs = timeoutMs;
    this.sdkClient = new SdkClient({
      name: 'ai-mcp-client',
      version: '0.1.0'
    });
  }

  public async listTools(): Promise<{ name: string; description: string }[]> {
    await this.ensureConnected();
    const response = await this.sdkClient.listTools(undefined, { timeout: this.timeoutMs });
    return response.tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? ''
    }));
  }

  public async callTool<TName extends ToolName>(
    name: TName,
    input: ToolInputMap[TName]
  ): Promise<ToolOutputMap[TName]> {
    await this.ensureConnected();
    const response = await this.sdkClient.callTool(
      {
        name,
        arguments: input as Record<string, unknown>
      },
      undefined,
      { timeout: this.timeoutMs }
    );

    if ('structuredContent' in response && response.structuredContent) {
      return response.structuredContent as ToolOutputMap[TName];
    }

    if ('content' in response && Array.isArray(response.content)) {
      const textBlock = response.content.find(
        (item): item is { type: 'text'; text: string } =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
      );
      if (textBlock) {
        return JSON.parse(textBlock.text) as ToolOutputMap[TName];
      }
    }

    throw new Error('Invalid tool call response');
  }

  public async close(): Promise<void> {
    await this.sdkClient.close();
  }

  private async ensureConnected(): Promise<void> {
    if (!this.connectPromise) {
      this.connectPromise = this.sdkClient.connect(this.transport);
    }
    await this.connectPromise;
  }
}

function parseCommand(command: string): { command: string; args: string[] } {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }

  const [file, ...args] = tokens;
  if (!file) {
    throw new Error(
      'A stdio endpoint command is required, e.g. "node dist/cli.js --transport stdio"'
    );
  }
  return { command: file, args };
}

function createTransport(options: CreateClientOptions): SdkTransport {
  if (!options.endpoint && options.transport !== 'stdio') {
    throw new Error('endpoint is required for http and sse transport');
  }

  if (!options.endpoint && options.transport === 'stdio') {
    throw new Error('endpoint command is required for stdio transport');
  }

  switch (options.transport) {
    case 'http':
      return new StreamableHTTPClientTransport(new URL(options.endpoint!)) as SdkTransport;
    case 'sse': {
      const endpoint = options.endpoint!;
      const normalizedEndpoint = endpoint.endsWith('/call') ? endpoint.slice(0, -5) : endpoint;
      return new SSEClientTransport(new URL(normalizedEndpoint)) as SdkTransport;
    }
    case 'stdio': {
      const stdioCommand = parseCommand(options.endpoint!);
      return new StdioClientTransport({
        command: stdioCommand.command,
        args: stdioCommand.args
      }) as SdkTransport;
    }
    default:
      throw new Error(`Unsupported transport: ${options.transport}`);
  }
}

export function createClient(options: CreateClientOptions): McpClient {
  return new McpClient(createTransport(options), options.timeoutMs ?? 10000);
}
