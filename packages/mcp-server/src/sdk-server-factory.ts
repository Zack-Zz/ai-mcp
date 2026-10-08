import { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
  type CallToolResult,
  type Tool,
  McpError as SdkMcpError
} from '@modelcontextprotocol/sdk/types.js';
import {
  CONTEXT_META_KEY,
  createInvocationId,
  createTraceId,
  invokeContextMetaSchema,
  McpError as ProjectMcpError,
  type InvocationContext,
  type InvocationFault,
  type InvocationOutcome,
  type ToolDescriptor
} from '@ai-mcp/shared';
import type { ToolDispatcher } from './tool-dispatcher.js';
import type { RegistrySnapshot } from './tool-registry.js';
import type { PromptDefinition, ResourceDefinition, ToolHandlerContext } from './types.js';

const DEFAULT_CALL_TIMEOUT_MS = 60_000;
const DEFAULT_PROTOCOL_VERSION = '2025-03-26';

export type ProtocolInstanceOptions = {
  snapshot: RegistrySnapshot;
  dispatcher: ToolDispatcher;
  resources: readonly ResourceDefinition<unknown, unknown>[];
  prompts: readonly PromptDefinition<unknown, unknown>[];
  serverInfo: { name: string; version: string };
  tenantId?: string;
  callTimeoutMs?: number;
  serviceSignal?: AbortSignal;
};

function toWireTool(descriptor: ToolDescriptor): Tool {
  // Runtime-verified through the SDK's own ToolSchema instead of a cast:
  // our descriptors are Ajv-compiled JSON objects with object roots.
  return ToolSchema.parse({
    name: descriptor.name,
    ...(descriptor.description !== undefined ? { description: descriptor.description } : {}),
    ...(descriptor.title !== undefined ? { title: descriptor.title } : {}),
    inputSchema: descriptor.inputSchema,
    ...(descriptor.outputSchema !== undefined ? { outputSchema: descriptor.outputSchema } : {}),
    ...(descriptor.annotations !== undefined ? { annotations: descriptor.annotations } : {}),
    ...(descriptor._meta !== undefined ? { _meta: descriptor._meta } : {})
  });
}

function toSdkJsonRpcCode(projectCode: string): number {
  if (projectCode === 'INVALID_PARAMS' || projectCode === 'INVALID_REQUEST') {
    return -32602;
  }
  if (projectCode === 'TIMEOUT') return -32001;
  return -32603;
}

function faultToSdkError(fault: InvocationFault): SdkMcpError {
  return new SdkMcpError(toSdkJsonRpcCode(fault.projectCode), fault.message, {
    category: fault.category,
    projectCode: fault.projectCode,
    traceId: fault.traceId,
    invocationId: fault.invocationId,
    executionDisposition: fault.executionDisposition,
    ...(fault.source?.backendId !== undefined ? { backendId: fault.source.backendId } : {})
  });
}

function buildInvocationContext(
  requestMeta: unknown,
  extra: { signal: AbortSignal; sessionId?: string; requestId: string | number },
  options: ProtocolInstanceOptions
): InvocationContext {
  const timeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  let traceId: string | undefined;
  let runId: string | undefined;
  let taskId: string | undefined;
  if (requestMeta !== undefined && typeof requestMeta === 'object' && requestMeta !== null) {
    const contextEntry = (requestMeta as Record<string, unknown>)[CONTEXT_META_KEY];
    const parsed = invokeContextMetaSchema.safeParse({ [CONTEXT_META_KEY]: contextEntry });
    if (parsed.success) {
      traceId = parsed.data[CONTEXT_META_KEY].traceId;
      runId = parsed.data[CONTEXT_META_KEY].runId;
      taskId = parsed.data[CONTEXT_META_KEY].taskId;
    }
  }

  const context: InvocationContext = {
    invocationId: createInvocationId(),
    traceId: traceId ?? createTraceId(),
    requestId: extra.requestId,
    peerEra: 'legacy',
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    ...(extra.sessionId !== undefined ? { mcpSessionId: extra.sessionId } : {}),
    ...(runId !== undefined ? { runId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    deadlineAt: timeoutMs > 0 ? Date.now() + timeoutMs : Number.MAX_SAFE_INTEGER,
    signal: options.serviceSignal
      ? AbortSignal.any([extra.signal, options.serviceSignal])
      : extra.signal,
    actor: { tenantId: options.tenantId ?? 'default' }
  };
  return context;
}

function presentToolResult(outcome: InvocationOutcome): CallToolResult {
  if (outcome.kind === 'failure') {
    // Known-tool parameter failures and business failures stay inside the
    // tool result channel (isError), preserving machine-readable payloads.
    // Everything else is a protocol-level JSON-RPC error.
    if (outcome.fault.category === 'invalid_params' || outcome.fault.category === 'tool_failure') {
      const errorPayload = {
        code: outcome.fault.projectCode,
        message: outcome.fault.message,
        traceId: outcome.fault.traceId,
        ...(outcome.fault.details ? { details: outcome.fault.details } : {})
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(errorPayload) }],
        structuredContent: errorPayload,
        isError: true
      };
    }
    throw faultToSdkError(outcome.fault);
  }
  return {
    // Content blocks were built by the registry closure as JSON objects with
    // type/text fields; the SDK accepts them as wire content blocks.
    content: outcome.result.content as unknown as CallToolResult['content'],
    ...(outcome.result.structuredContent !== undefined
      ? { structuredContent: outcome.result.structuredContent as Record<string, unknown> }
      : {}),
    isError: outcome.kind === 'tool_failure' || outcome.result.isError,
    ...(outcome.result._meta ? { _meta: outcome.result._meta } : {})
  };
}

/**
 * Creates one SDK protocol instance bound to the shared business kernel.
 * Each instance owns exactly one transport for its whole life (connected by
 * the caller); registry/dispatcher/business state stay service-owned.
 */
export function createProtocolInstance(options: ProtocolInstanceOptions): SdkMcpServer {
  const sdk = new SdkMcpServer(options.serverInfo, {
    // Tools are served by our low-level handlers; declare the capability up
    // front because no high-level registerTool call will set it.
    capabilities: {
      tools: {},
      ...(options.resources.length > 0 ? { resources: {} } : {}),
      ...(options.prompts.length > 0 ? { prompts: {} } : {})
    }
  });

  for (const resource of options.resources) {
    const uri = `resource://ai-mcp/${resource.name}`;
    sdk.registerResource(
      resource.name,
      uri,
      { description: resource.description },
      async (_uri, extra) => {
        const handlerContext: ToolHandlerContext = {
          traceId: createTraceId(),
          requestId: extra.requestId
        };
        const output = await resource.handler({} as never, handlerContext);
        const validated = resource.outputSchema.safeParse(output);
        if (!validated.success) {
          throw new ProjectMcpError(
            'INTERNAL',
            `Invalid output from resource: ${resource.name}`,
            handlerContext.traceId,
            { issues: validated.error.issues }
          );
        }
        return {
          contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(validated.data) }]
        };
      }
    );
  }

  if (options.prompts.length > 0) {
    // Low-level prompt handlers: the high-level wrapper requires an
    // arguments object even for optional-argument prompts and invokes
    // argless callbacks with a shifted signature.
    sdk.server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: options.prompts.map((prompt) => ({
        name: prompt.name,
        description: prompt.description
      }))
    }));

    sdk.server.setRequestHandler(
      GetPromptRequestSchema,
      async (request, extra): Promise<{ description?: string; messages: unknown[] }> => {
        const name = request.params?.name ?? '';
        const prompt = options.prompts.find((candidate) => candidate.name === name);
        if (!prompt) {
          throw new SdkMcpError(-32602, `Unknown prompt: ${name}`);
        }
        const handlerContext: ToolHandlerContext = {
          traceId: createTraceId(),
          requestId: extra.requestId
        };
        const parsedArgs = await prompt.argsSchema.safeParseAsync(request.params?.arguments ?? {});
        if (!parsedArgs.success) {
          throw new SdkMcpError(
            -32602,
            `Invalid arguments for prompt ${name}: ${parsedArgs.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; ')}`
          );
        }
        const output = await prompt.handler(parsedArgs.data as never, handlerContext);
        const validated = prompt.outputSchema.safeParse(output);
        if (!validated.success) {
          throw new ProjectMcpError(
            'INTERNAL',
            `Invalid output from prompt: ${name}`,
            handlerContext.traceId,
            { issues: validated.error.issues }
          );
        }
        const promptOutput = validated.data as { title?: string; content?: string };
        return {
          ...(promptOutput.title !== undefined ? { description: promptOutput.title } : {}),
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

  // Low-level handlers keep numeric codes and structured data intact; the
  // high-level registerTool wrapper would flatten failures to text-only
  // isError results.
  sdk.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: options.snapshot.descriptors.map(toWireTool)
  }));

  sdk.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const context = buildInvocationContext(request.params?._meta, extra, options);
    try {
      const args: unknown = request.params?.arguments ?? {};
      const outcome = await options.dispatcher.invoke(request.params?.name ?? '', args, context);
      return presentToolResult(outcome);
    } catch (error) {
      if (error instanceof ProjectMcpError) {
        throw new SdkMcpError(toSdkJsonRpcCode(error.code), error.message, {
          traceId: error.traceId,
          details: error.details
        });
      }
      throw error;
    }
  });

  return sdk;
}
