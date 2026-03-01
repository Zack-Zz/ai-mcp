import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import {
  type JsonValue,
  McpError,
  createTraceId,
  normalizeError,
  rpcRequestSchema,
  type PromptName,
  type ResourceName,
  toolSchemas,
  toolsCallRequestSchema,
  type RpcRequest,
  type ToolName,
  type TransportKind
} from '@ai-mcp/shared';
import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type {
  Middleware,
  MiddlewareNext,
  PromptDefinition,
  ResourceDefinition,
  RpcOk,
  RpcOutput,
  ServerContext,
  ToolDefinition
} from './types.js';
import { builtInPrompts, builtInResources, builtInTools } from './tools.js';

export type CreateServerOptions = {
  includeBuiltInTools?: boolean;
};

export type StartHttpOptions = {
  port: number;
};

export type StartSseOptions = {
  port: number;
  path?: string;
};

const HTTP_RPC_PATH = '/mcp';
type SdkTransport = Parameters<SdkMcpServer['connect']>[0];

export class McpServer {
  private readonly sdkServer = new SdkMcpServer({
    name: 'ai-mcp-server',
    version: '0.1.0'
  });

  private readonly tools = new Map<ToolName, ToolDefinition<unknown, unknown>>();
  private readonly resources = new Map<ResourceName, ResourceDefinition<unknown, unknown>>();
  private readonly prompts = new Map<PromptName, PromptDefinition<unknown, unknown>>();

  private readonly middlewares: Middleware[] = [];
  private connectedTransport: SdkTransport | null = null;

  public constructor(options: CreateServerOptions = {}) {
    if (options.includeBuiltInTools ?? true) {
      for (const tool of builtInTools) {
        this.registerTool(tool as ToolDefinition<unknown, unknown>);
      }
      for (const resource of builtInResources) {
        this.registerResource(resource);
      }
      for (const prompt of builtInPrompts) {
        this.registerPrompt(prompt);
      }
    }
  }

  public registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    if (this.tools.has(tool.name)) {
      throw new McpError('INVALID_PARAMS', `Tool already registered: ${tool.name}`);
    }

    this.tools.set(tool.name, tool as ToolDefinition<unknown, unknown>);
    this.sdkServer.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema
      },
      async (input, extra) => {
        const traceId = String(extra.requestId ?? createTraceId());
        await this.runMiddlewares({ traceId, method: 'tools/call' });

        const output = await tool.handler(input as TInput, { traceId });
        const validatedOutput = tool.outputSchema.safeParse(output);
        if (!validatedOutput.success) {
          throw new McpError('INTERNAL', `Invalid output from tool: ${tool.name}`, traceId, {
            issues: validatedOutput.error.issues
          });
        }

        const structuredContent = validatedOutput.data as Record<string, unknown>;
        return {
          content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
          structuredContent
        };
      }
    );
  }

  public use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  public registerResource<TParams, TOutput>(resource: ResourceDefinition<TParams, TOutput>): void {
    if (this.resources.has(resource.name)) {
      throw new McpError('INVALID_PARAMS', `Resource already registered: ${resource.name}`);
    }

    this.resources.set(resource.name, resource as ResourceDefinition<unknown, unknown>);
    const uri = `resource://ai-mcp/${resource.name}`;

    this.sdkServer.registerResource(
      resource.name,
      uri,
      { description: resource.description },
      async (_uri, extra) => {
        const traceId = String(extra.requestId ?? createTraceId());
        await this.runMiddlewares({ traceId, method: 'resources/list' });

        const output = await resource.handler({} as TParams, { traceId });
        const validatedOutput = resource.outputSchema.safeParse(output);
        if (!validatedOutput.success) {
          throw new McpError(
            'INTERNAL',
            `Invalid output from resource: ${resource.name}`,
            traceId,
            {
              issues: validatedOutput.error.issues
            }
          );
        }

        return {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(validatedOutput.data)
            }
          ]
        };
      }
    );
  }

  public registerPrompt<TArgs, TOutput>(prompt: PromptDefinition<TArgs, TOutput>): void {
    if (this.prompts.has(prompt.name)) {
      throw new McpError('INVALID_PARAMS', `Prompt already registered: ${prompt.name}`);
    }

    this.prompts.set(prompt.name, prompt as PromptDefinition<unknown, unknown>);
    this.sdkServer.registerPrompt(
      prompt.name,
      {
        description: prompt.description
      },
      async (args, extra) => {
        const traceId = String(extra.requestId ?? createTraceId());
        await this.runMiddlewares({ traceId, method: 'prompts/list' });

        const output = await prompt.handler((args ?? {}) as TArgs, { traceId });
        const validatedOutput = prompt.outputSchema.safeParse(output);
        if (!validatedOutput.success) {
          throw new McpError('INTERNAL', `Invalid output from prompt: ${prompt.name}`, traceId, {
            issues: validatedOutput.error.issues
          });
        }

        const promptOutput = validatedOutput.data as { title?: string; content?: string };
        return {
          description: promptOutput.title,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: promptOutput.content ?? JSON.stringify(promptOutput)
              }
            }
          ]
        };
      }
    );
  }

  public listTools(): { name: string; description: string }[] {
    return Array.from(this.tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description
    }));
  }

  public listResources(): { name: ResourceName; description: string }[] {
    return Array.from(this.resources.values()).map((resource) => ({
      name: resource.name,
      description: resource.description
    }));
  }

  public listPrompts(): { name: PromptName; description: string }[] {
    return Array.from(this.prompts.values()).map((prompt) => ({
      name: prompt.name,
      description: prompt.description
    }));
  }

  // Compatibility path for unit tests and legacy in-memory invocation.
  public async handleRawRequest(raw: unknown): Promise<RpcOutput> {
    const traceId = createTraceId();
    let parsed: RpcRequest;
    try {
      parsed = rpcRequestSchema.parse(raw);
    } catch (error) {
      return {
        id: 'unknown',
        error: normalizeError(
          new McpError('INVALID_PARAMS', 'Invalid request payload', traceId, { cause: error }),
          traceId
        )
      };
    }

    try {
      await this.runMiddlewares({ traceId, method: parsed.method });
      const result = await this.handleRequest(parsed, traceId);
      return {
        id: parsed.id,
        result
      };
    } catch (error) {
      return {
        id: parsed.id,
        error: normalizeError(error, traceId)
      };
    }
  }

  public startStdio(): void {
    const transport = new StdioServerTransport() as SdkTransport;
    void this.connectTransport(transport);
  }

  public startHttp(options: StartHttpOptions): ReturnType<typeof createHttpServer> {
    const transport = new StreamableHTTPServerTransport();
    void this.connectTransport(transport as SdkTransport);

    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (!req.url?.startsWith(HTTP_RPC_PATH)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        const traceId = createTraceId();
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'unknown',
            error: {
              code: 'INTERNAL',
              message: error instanceof Error ? error.message : String(error),
              traceId
            }
          })
        );
      }
    });

    httpServer.listen(options.port);
    return httpServer;
  }

  public startSse(options: StartSseOptions): ReturnType<typeof createHttpServer> {
    const path = options.path ?? '/sse';
    const sseTransports = new Map<string, SSEServerTransport>();

    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'GET' && req.url === path) {
        const transport = new SSEServerTransport(`${path}/call`, res);
        sseTransports.set(transport.sessionId, transport);
        transport.onclose = () => {
          sseTransports.delete(transport.sessionId);
        };

        try {
          await this.connectTransport(transport as SdkTransport);
        } catch (error) {
          sseTransports.delete(transport.sessionId);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) })
          );
        }
        return;
      }

      if (req.method === 'POST' && req.url?.startsWith(`${path}/call`)) {
        const url = new URL(req.url, 'http://localhost');
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId is required' }));
          return;
        }

        const transport = sseTransports.get(sessionId);
        if (!transport) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'SSE session not found' }));
          return;
        }

        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    httpServer.listen(options.port);
    return httpServer;
  }

  public supports(transport: TransportKind): boolean {
    return ['stdio', 'http', 'sse'].includes(transport);
  }

  private async connectTransport(transport: SdkTransport): Promise<void> {
    if (this.connectedTransport) {
      await this.sdkServer.close();
      this.connectedTransport = null;
    }

    await this.sdkServer.connect(transport);
    this.connectedTransport = transport;
  }

  private async handleRequest(request: RpcRequest, traceId: string): Promise<RpcOk['result']> {
    if (request.method === 'tools/list') {
      return {
        tools: this.listTools()
      };
    }

    if (request.method === 'resources/list') {
      return {
        resources: this.listResources()
      };
    }

    if (request.method === 'prompts/list') {
      return {
        prompts: this.listPrompts()
      };
    }

    if (request.method !== 'tools/call') {
      throw new McpError('INVALID_PARAMS', `Unsupported method: ${request.method}`, traceId);
    }

    const params = toolsCallRequestSchema.parse(request.params);
    const tool = this.tools.get(params.name);

    if (!tool) {
      throw new McpError('INVALID_PARAMS', `Tool not found: ${params.name}`, traceId, {
        toolName: params.name
      });
    }

    const input = this.validateInput(params.name, params.input, traceId);
    const output = await tool.handler(input, { traceId });
    const validatedOutput = tool.outputSchema.safeParse(output);

    if (!validatedOutput.success) {
      throw new McpError('INTERNAL', `Invalid output from tool: ${params.name}`, traceId, {
        issues: validatedOutput.error.issues
      });
    }

    return { output: validatedOutput.data as JsonValue | Record<string, JsonValue> };
  }

  private validateInput(name: ToolName, input: unknown, traceId: string): unknown {
    const schema = toolSchemas[name].input;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      throw new McpError('INVALID_PARAMS', `Invalid input for tool: ${name}`, traceId, {
        issues: parsed.error.issues
      });
    }
    return parsed.data;
  }

  private async runMiddlewares(ctx: ServerContext): Promise<void> {
    let index = -1;
    const runner = async (position: number): Promise<void> => {
      if (position <= index) {
        throw new Error('next() called multiple times');
      }
      index = position;
      const middleware = this.middlewares[position];
      if (!middleware) {
        return;
      }
      const next: MiddlewareNext = async () => runner(position + 1);
      await middleware(ctx, next);
    };
    await runner(0);
  }
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  return new McpServer(options);
}
