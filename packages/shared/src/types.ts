import { z } from 'zod';

export const transportKindSchema = z.enum(['stdio', 'http', 'sse']);
export type TransportKind = z.infer<typeof transportKindSchema>;

export const errorCodeSchema = z.enum(['INVALID_PARAMS', 'UNAUTHORIZED', 'TIMEOUT', 'INTERNAL']);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

export const mcpErrorSchema = z.object({
  code: errorCodeSchema,
  message: z.string(),
  traceId: z.string(),
  details: z.unknown().optional()
});
export type McpErrorShape = z.infer<typeof mcpErrorSchema>;

export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema)
  ])
);

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [k: string]: JsonValue };

export type ToolName = 'echo' | 'time';
export type ResourceName = 'server-info';
export type PromptName = 'tool-guide';

export type ToolInputMap = {
  echo: { text: string; metadata?: Record<string, JsonValue> | undefined };
  time: { timezone?: string | undefined };
};

export type ToolOutputMap = {
  echo: { text: string; metadata?: Record<string, JsonValue> | undefined };
  time: { iso: string; timezone: string };
};

export type ToolListItem = {
  name: string;
  description: string;
};

export type ResourceListItem = {
  name: string;
  description: string;
};

export type PromptListItem = {
  name: string;
  description: string;
};

export const toolSchemas = {
  echo: {
    input: z.object({
      text: z.string().min(1),
      metadata: z.record(z.string(), jsonValueSchema).optional()
    }),
    output: z.object({
      text: z.string(),
      metadata: z.record(z.string(), jsonValueSchema).optional()
    })
  },
  time: {
    input: z.object({
      timezone: z.string().optional()
    }),
    output: z.object({
      iso: z.string(),
      timezone: z.string()
    })
  }
} as const;

const toolNameSchema = z.enum(['echo', 'time']);
const resourceNameSchema = z.enum(['server-info']);
const promptNameSchema = z.enum(['tool-guide']);

export const rpcRequestSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['tools/list', 'tools/call', 'resources/list', 'prompts/list']),
  params: z.unknown().optional()
});
export type RpcRequest = z.infer<typeof rpcRequestSchema>;

const toolsListResultSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string()
    })
  )
});

const toolsCallParamsSchema = z.object({
  name: toolNameSchema,
  input: z.unknown()
});

const toolsCallResultSchema = z.object({
  output: z.unknown()
});

export const resourceSchemas = {
  'server-info': {
    params: z.object({}).optional(),
    output: z.object({
      name: z.string(),
      version: z.string(),
      transports: z.array(transportKindSchema)
    })
  }
} as const;

export const promptSchemas = {
  'tool-guide': {
    args: z.object({ toolName: toolNameSchema.optional() }).optional(),
    output: z.object({
      title: z.string(),
      content: z.string()
    })
  }
} as const;

export const resourcesListResultSchema = z.object({
  resources: z.array(
    z.object({
      name: resourceNameSchema,
      description: z.string()
    })
  )
});

export const promptsListResultSchema = z.object({
  prompts: z.array(
    z.object({
      name: promptNameSchema,
      description: z.string()
    })
  )
});

export const rpcResponseSchema = z.object({
  id: z.string().min(1),
  result: z
    .union([
      toolsListResultSchema,
      toolsCallResultSchema,
      resourcesListResultSchema,
      promptsListResultSchema
    ])
    .optional(),
  error: mcpErrorSchema.optional()
});
export type RpcResponse = z.infer<typeof rpcResponseSchema>;

export const toolsCallRequestSchema = toolsCallParamsSchema;

export type ToolCallParams = z.infer<typeof toolsCallParamsSchema>;
