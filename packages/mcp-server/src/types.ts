import type {
  InvocationOutcome,
  JsonObject,
  McpErrorShape,
  PromptListItem,
  PromptName,
  ResourceListItem,
  ResourceName,
  ToolListItem
} from '@ai-mcp/shared';
import type { ZodType } from 'zod';

/**
 * Context handed to local tool/resource/prompt handlers. Existing handlers
 * that only consume `traceId` keep compiling; richer fields arrive as the
 * dispatcher provides them.
 */
export type ToolHandlerContext = {
  traceId: string;
  invocationId?: string;
  requestId?: string | number;
  mcpSessionId?: string;
  runId?: string;
  taskId?: string;
  signal?: AbortSignal;
};

export type ToolResultContract = 'native-json/v1' | 'standard/v1';

export type ToolDefinition<TInput = unknown, TOutput = unknown> = {
  /** Any legal business name; the legacy echo/time enum is no longer required. */
  name: string;
  description: string;
  title?: string;
  inputSchema: ZodType<TInput>;
  outputSchema: ZodType<TOutput>;
  resultContract?: ToolResultContract;
  annotations?: JsonObject;
  _meta?: JsonObject;
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
  name: string;
  input: JsonObject;
};

export type ToolCallResult = {
  output: JsonObject;
};

/** Summary of the real invocation result, filled by the dispatcher terminal. */
export type InvocationOutcomeSummary = 'ok' | 'tool_error' | 'error';

export type ServerContext = {
  traceId: string;
  method: 'tools/list' | 'tools/call' | 'resources/list' | 'prompts/list';
  toolName?: string;
  invocationId?: string;
  outcome?: InvocationOutcomeSummary;
  faultCode?: string;
  outcomeDetail?: InvocationOutcome;
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
