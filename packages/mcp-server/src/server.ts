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
import { startHttpServer } from './transports/http.js';
import { startSseServer } from './transports/sse.js';
import { startStdioServer } from './transports/stdio.js';
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

export class McpServer {
  private readonly tools = new Map<ToolName, ToolDefinition<unknown, unknown>>();
  private readonly resources = new Map<ResourceName, ResourceDefinition<unknown, unknown>>();
  private readonly prompts = new Map<PromptName, PromptDefinition<unknown, unknown>>();

  private readonly middlewares: Middleware[] = [];

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
  }

  public use(middleware: Middleware): void {
    this.middlewares.push(middleware);
  }

  public registerResource<TParams, TOutput>(resource: ResourceDefinition<TParams, TOutput>): void {
    if (this.resources.has(resource.name)) {
      throw new McpError('INVALID_PARAMS', `Resource already registered: ${resource.name}`);
    }
    this.resources.set(resource.name, resource as ResourceDefinition<unknown, unknown>);
  }

  public registerPrompt<TArgs, TOutput>(prompt: PromptDefinition<TArgs, TOutput>): void {
    if (this.prompts.has(prompt.name)) {
      throw new McpError('INVALID_PARAMS', `Prompt already registered: ${prompt.name}`);
    }
    this.prompts.set(prompt.name, prompt as PromptDefinition<unknown, unknown>);
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
    startStdioServer(this);
  }

  public startHttp(options: StartHttpOptions): ReturnType<typeof startHttpServer> {
    return startHttpServer(this, options);
  }

  public startSse(options: StartSseOptions): ReturnType<typeof startSseServer> {
    return startSseServer(this, options);
  }

  public supports(transport: TransportKind): boolean {
    return ['stdio', 'http', 'sse'].includes(transport);
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
