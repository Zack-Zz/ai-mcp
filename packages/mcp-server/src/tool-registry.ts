import { toJSONSchema, type ZodType } from 'zod';
import {
  isJsonObject,
  isJsonValue,
  isLegalToolName,
  McpError,
  RESULT_CONTRACT_META_KEY,
  SchemaCompiler,
  CONTEXT_META_KEY,
  standardToolResultEnvelopeSchema,
  type InvocationContext,
  type InvocationFault,
  type InvocationOutcome,
  type JsonObject,
  type ResolvedResultContract,
  type ToolDescriptor
} from '@ai-mcp/shared';
import type { ToolDefinition, ToolHandlerContext } from './types.js';

export type RegisteredTool = {
  readonly descriptor: Readonly<ToolDescriptor>;
  readonly contract: ResolvedResultContract;
  invoke(
    input: unknown,
    context: InvocationContext,
    onExecutionStarted?: () => void
  ): Promise<InvocationOutcome>;
};

export type RegistrySnapshot = {
  readonly revision: string;
  readonly descriptors: readonly Readonly<ToolDescriptor>[];
  find(name: string): RegisteredTool | undefined;
};

/** Identity helper so schema inference flows into handler input/output types. */
export function defineTool<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>
): ToolDefinition<TInput, TOutput> {
  return definition;
}

function exportJsonSchema(
  schema: ZodType<unknown>,
  label: string,
  io: 'input' | 'output'
): JsonObject {
  let exported: unknown;
  try {
    // Input schemas publish the accepting range; output schemas publish the
    // produced range (transforms/defaults differ between the two views).
    exported = toJSONSchema(schema, { io, unrepresentable: 'throw' });
  } catch (error) {
    throw new McpError(
      'INVALID_PARAMS',
      `Schema for ${label} cannot be represented as JSON Schema: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (!isJsonObject(exported)) {
    throw new McpError('INVALID_PARAMS', `Schema for ${label} must be a JSON object`);
  }
  return exported;
}

function toHandlerContext(context: InvocationContext): ToolHandlerContext {
  return {
    traceId: context.traceId,
    invocationId: context.invocationId,
    ...(context.requestId !== undefined ? { requestId: context.requestId } : {}),
    ...(context.mcpSessionId !== undefined ? { mcpSessionId: context.mcpSessionId } : {}),
    ...(context.runId !== undefined ? { runId: context.runId } : {}),
    ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
    signal: context.signal
  };
}

function inputFault(
  context: InvocationContext,
  message: string,
  details?: JsonObject
): InvocationFault {
  return {
    category: 'invalid_params',
    projectCode: 'INVALID_PARAMS',
    message,
    traceId: context.traceId,
    invocationId: context.invocationId,
    executionDisposition: 'not_started',
    source: { kind: 'local' },
    ...(details ? { details } : {})
  };
}

function compileDefinition<TInput, TOutput>(
  definition: ToolDefinition<TInput, TOutput>,
  compiler: SchemaCompiler
): RegisteredTool {
  const { name } = definition;
  const inputSchema = exportJsonSchema(definition.inputSchema, `tool ${name} input`, 'input');
  const outputSchema = exportJsonSchema(definition.outputSchema, `tool ${name} output`, 'output');
  if (inputSchema.type !== 'object' || outputSchema.type !== 'object') {
    throw new McpError(
      'INVALID_PARAMS',
      `Tool ${name} input/output schema roots must be JSON objects; wrap arrays/scalars in named fields`
    );
  }
  try {
    compiler.compile(inputSchema);
    compiler.compile(outputSchema);
  } catch (error) {
    throw new McpError(
      'INVALID_PARAMS',
      `Tool ${name} schema failed to compile: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const contract: ResolvedResultContract = definition.resultContract ?? 'native-json/v1';
  const descriptor: ToolDescriptor = {
    name,
    description: definition.description,
    ...(definition.title !== undefined ? { title: definition.title } : {}),
    inputSchema,
    outputSchema,
    ...(definition.annotations !== undefined ? { annotations: definition.annotations } : {}),
    // The declared contract rides on the descriptor so gateways never have
    // to guess business intent from schema shapes.
    _meta: {
      ...(definition._meta ?? {}),
      [RESULT_CONTRACT_META_KEY]: contract
    }
  };

  // Capture the concrete schema/handler references once; the closure keeps
  // its own TInput/TOutput typing and never sees the type-erased registry.
  const inputSchemaRef = definition.inputSchema;
  const outputSchemaRef = definition.outputSchema;
  const handlerRef = definition.handler;

  const execute = async (
    input: unknown,
    context: InvocationContext,
    markStarted: () => void
  ): Promise<InvocationOutcome> => {
    const parsedInput = await inputSchemaRef.safeParseAsync(input);
    if (!parsedInput.success) {
      return {
        kind: 'failure',
        fault: inputFault(context, `Invalid input for tool: ${name}`, {
          issues: parsedInput.error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message
          }))
        })
      };
    }
    if (!isJsonValue(parsedInput.data)) {
      return {
        kind: 'failure',
        fault: inputFault(context, `Input for tool ${name} is not JSON serializable`)
      };
    }

    if (context.signal.aborted) throw context.signal.reason;
    markStarted();
    let output: TOutput;
    try {
      output = await handlerRef(parsedInput.data, toHandlerContext(context));
    } catch (error) {
      const cancelled = context.signal.aborted;
      const message = error instanceof Error ? error.message : String(error);
      return {
        kind: 'failure',
        fault: {
          category: cancelled ? 'cancelled' : 'tool_failure',
          projectCode: cancelled ? 'CANCELLED' : 'TOOL_FAILED',
          message,
          traceId: context.traceId,
          invocationId: context.invocationId,
          executionDisposition: 'completed',
          source: { kind: 'local' }
        }
      };
    }

    const parsedOutput = await outputSchemaRef.safeParseAsync(output);
    if (!parsedOutput.success) {
      return {
        kind: 'failure',
        fault: {
          category: 'invalid_result',
          projectCode: 'INVALID_RESULT',
          message: `Invalid output from tool: ${name}`,
          traceId: context.traceId,
          invocationId: context.invocationId,
          executionDisposition: 'completed',
          source: { kind: 'local' },
          details: {
            issues: parsedOutput.error.issues.map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message
            }))
          }
        }
      };
    }
    if (!isJsonValue(parsedOutput.data)) {
      return {
        kind: 'failure',
        fault: {
          category: 'invalid_result',
          projectCode: 'INVALID_RESULT',
          message: `Output from tool ${name} is not JSON serializable`,
          traceId: context.traceId,
          invocationId: context.invocationId,
          executionDisposition: 'completed',
          source: { kind: 'local' }
        }
      };
    }

    if (!isJsonObject(parsedOutput.data)) {
      return {
        kind: 'failure',
        fault: {
          category: 'invalid_result',
          projectCode: 'INVALID_RESULT',
          message: `Output from tool ${name} is not a JSON object`,
          traceId: context.traceId,
          invocationId: context.invocationId,
          executionDisposition: 'completed',
          source: { kind: 'local' }
        }
      };
    }
    const result = {
      content: [{ type: 'text', text: JSON.stringify(parsedOutput.data) }],
      structuredContent: parsedOutput.data,
      isError: false,
      _meta: {
        [CONTEXT_META_KEY]: {
          traceId: context.traceId,
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.taskId ? { taskId: context.taskId } : {})
        }
      }
    };
    if (contract === 'standard/v1') {
      const envelope = standardToolResultEnvelopeSchema.safeParse(parsedOutput.data);
      if (!envelope.success) {
        return {
          kind: 'failure',
          fault: {
            category: 'invalid_result',
            projectCode: 'INVALID_RESULT',
            message: `Tool ${name} returned an invalid standard envelope`,
            traceId: context.traceId,
            invocationId: context.invocationId,
            executionDisposition: 'completed',
            source: { kind: 'local' }
          }
        };
      }
      if (!envelope.data.ok) {
        return {
          kind: 'tool_failure',
          result: { ...result, isError: true },
          fault: {
            category: 'tool_failure',
            projectCode: envelope.data.code,
            message: envelope.data.message,
            traceId: context.traceId,
            invocationId: context.invocationId,
            executionDisposition: 'completed',
            source: { kind: 'local' }
          }
        };
      }
    }
    return { kind: 'success', result };
  };

  const invoke = async (
    input: unknown,
    context: InvocationContext,
    onExecutionStarted?: () => void
  ): Promise<InvocationOutcome> => {
    const controller = new AbortController();
    let started = false;
    let timer: NodeJS.Timeout | undefined;
    const abort = () => controller.abort(context.signal.reason);
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const remaining = context.deadlineAt - Date.now();
    if (remaining <= 0)
      controller.abort(new DOMException('Tool call deadline exceeded', 'TimeoutError'));
    else if (remaining < 2_147_483_647)
      timer = setTimeout(
        () => controller.abort(new DOMException('Tool call deadline exceeded', 'TimeoutError')),
        remaining
      );
    let onAbort!: () => void;
    const interrupted = new Promise<InvocationOutcome>((resolve) => {
      onAbort = () => {
        const timeout =
          controller.signal.reason instanceof Error &&
          controller.signal.reason.name === 'TimeoutError';
        resolve({
          kind: 'failure',
          fault: {
            category: timeout ? 'backend_timeout' : 'cancelled',
            projectCode: timeout ? 'TIMEOUT' : 'CANCELLED',
            message: timeout ? 'Tool call deadline exceeded' : 'Tool call cancelled',
            traceId: context.traceId,
            invocationId: context.invocationId,
            executionDisposition: started ? 'unknown' : 'not_started',
            source: { kind: 'local' }
          }
        });
      };
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    try {
      if (controller.signal.aborted) return await interrupted;
      return await Promise.race([
        execute(input, { ...context, signal: controller.signal }, () => {
          started = true;
          onExecutionStarted?.();
        }),
        interrupted
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      context.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
    }
  };

  return { descriptor, contract, invoke };
}

/**
 * Heterogeneous tool store. Each entry keeps its own typed invoke closure;
 * nothing is coerced through `ToolDefinition<unknown, unknown>`.
 * Register before serving: the snapshot freezes on first serve and later
 * registration attempts fail loudly (no hot-reload in this phase).
 */
export class ToolRegistry {
  private readonly compiler = new SchemaCompiler();
  private readonly tools = new Map<string, RegisteredTool>();
  private frozenSnapshot: RegistrySnapshot | null = null;

  public get size(): number {
    return this.tools.size;
  }

  public get isFrozen(): boolean {
    return this.frozenSnapshot !== null;
  }

  public register<TInput, TOutput>(definition: ToolDefinition<TInput, TOutput>): void {
    if (this.frozenSnapshot) {
      throw new McpError(
        'INVALID_PARAMS',
        `Cannot register tool after the server started serving: ${definition.name}`
      );
    }
    if (!isLegalToolName(definition.name)) {
      throw new McpError(
        'INVALID_PARAMS',
        `Invalid tool name: ${definition.name} (1-128 chars of ASCII letters/digits/_/-/.)`
      );
    }
    if (this.tools.has(definition.name)) {
      throw new McpError('INVALID_PARAMS', `Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, compileDefinition(definition, this.compiler));
  }

  public freeze(): RegistrySnapshot {
    if (this.frozenSnapshot) {
      return this.frozenSnapshot;
    }
    const tools = new Map(this.tools);
    const descriptors = Array.from(tools.values(), (tool) => tool.descriptor);
    const frozenSnapshot: RegistrySnapshot = {
      revision: `${descriptors.length}:${Array.from(tools.keys()).sort().join(',')}`,
      descriptors,
      find: (name: string) => tools.get(name)
    };
    this.frozenSnapshot = frozenSnapshot;
    return frozenSnapshot;
  }

  /** Brief projection for the legacy list API; works before and after freeze. */
  public listBrief(): { name: string; description: string }[] {
    return Array.from(this.tools.values(), (tool) => ({
      name: tool.descriptor.name,
      description: tool.descriptor.description ?? ''
    }));
  }
}
