import type {
  JsonValue,
  McpErrorShape,
  PromptListItem,
  PromptName,
  ResourceListItem,
  ResourceName,
  ToolListItem,
  ToolName
} from '@ai-mcp/shared';
import type { ZodType } from 'zod';

export type ToolHandlerContext = {
  traceId: string;
};

export type ToolDefinition<TInput, TOutput> = {
  name: ToolName;
  description: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  handler: (input: TInput, context: ToolHandlerContext) => Promise<TOutput> | TOutput;
};

export type ResourceDefinition<TParams, TOutput> = {
  name: ResourceName;
  description: string;
  paramsSchema: ZodType<TParams>;
  outputSchema: ZodType<TOutput>;
  handler: (params: TParams, context: ToolHandlerContext) => Promise<TOutput> | TOutput;
};

export type PromptDefinition<TArgs, TOutput> = {
  name: PromptName;
  description: string;
  argsSchema: ZodType<TArgs>;
  outputSchema: ZodType<TOutput>;
  handler: (args: TArgs, context: ToolHandlerContext) => Promise<TOutput> | TOutput;
};

export type ToolCallRequest = {
  name: ToolName;
  input: JsonValue | Record<string, JsonValue>;
};

export type ToolCallResult = {
  output: JsonValue | Record<string, JsonValue>;
};

export type ServerContext = {
  traceId: string;
  method: 'tools/list' | 'tools/call' | 'resources/list' | 'prompts/list';
};

export type MiddlewareNext = () => Promise<void>;

export type Middleware = (ctx: ServerContext, next: MiddlewareNext) => Promise<void>;

export type RpcOk = {
  id: string;
  result:
    | { tools: ToolListItem[] }
    | ToolCallResult
    | { resources: ResourceListItem[] }
    | { prompts: PromptListItem[] };
};

export type RpcErr = {
  id: string;
  error: McpErrorShape;
};

export type RpcOutput = RpcOk | RpcErr;
