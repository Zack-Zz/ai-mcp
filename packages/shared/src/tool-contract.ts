import { z } from 'zod';
import { type JsonObject, type JsonValue, jsonValueSchema } from './types.js';
import { artifactRefSchema } from './types.js';

/**
 * Project tool-name rule: case sensitive, 1-128 chars, ASCII letters, digits,
 * underscore, hyphen and dot. This is the ai-mcp registration rule, not a
 * claim about every MCP implementation.
 */
export const TOOL_NAME_MAX_LENGTH = 128;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export function isLegalToolName(name: string): boolean {
  return TOOL_NAME_PATTERN.test(name);
}

export const toolNameSchema = z.string().refine(isLegalToolName, {
  message: 'Tool name must be 1-128 chars of ASCII letters/digits/_/-/.'
});

const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

export type ToolDescriptor = {
  name: string;
  description?: string | undefined;
  title?: string | undefined;
  inputSchema: JsonObject;
  outputSchema?: JsonObject | undefined;
  annotations?: JsonObject | undefined;
  icons?: JsonObject[] | undefined;
  _meta?: JsonObject | undefined;
  /** Execution capabilities advertised by the downstream (e.g. taskSupport). */
  execution?: JsonObject | undefined;
  /** Descriptor extensions the project does not interpret. */
  extensions?: JsonObject | undefined;
};

export const toolDescriptorSchema = z.object({
  name: toolNameSchema,
  description: z.string().optional(),
  title: z.string().optional(),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema.optional(),
  annotations: jsonObjectSchema.optional(),
  icons: z.array(jsonObjectSchema).optional(),
  _meta: jsonObjectSchema.optional(),
  execution: jsonObjectSchema.optional(),
  extensions: jsonObjectSchema.optional()
});

export type NativeToolResult = {
  content: JsonObject[];
  structuredContent?: JsonValue | undefined;
  isError: boolean;
  _meta?: JsonObject | undefined;
};

export const nativeToolResultSchema = z.object({
  content: z.array(jsonObjectSchema),
  structuredContent: jsonValueSchema.optional(),
  isError: z.boolean(),
  _meta: jsonObjectSchema.optional()
});

export const resultContractSchema = z.enum(['native-json/v1', 'standard/v1', 'legacy-auto']);
export type ResultContract = z.infer<typeof resultContractSchema>;
export type ResolvedResultContract = Exclude<ResultContract, 'legacy-auto'>;

export const RESULT_CONTRACT_META_KEY = 'org.ai-mcp/result-contract';
export const CONTEXT_META_KEY = 'org.ai-mcp/context';
export const DOWNSTREAM_TOOL_META_KEY = 'org.ai-mcp/downstream-tool';

const contextIdentitySchema = z
  .object({
    traceId: z.string().min(1).max(128),
    runId: z.string().min(1).max(128).optional(),
    taskId: z.string().min(1).max(128).optional()
  })
  .strict();

/**
 * Parses `_meta['org.ai-mcp/context']` from an MCP request. Caller-supplied
 * identity never includes actor/tenant/risk: those stay server-owned.
 */
export const invokeContextMetaSchema = z
  .object({
    [CONTEXT_META_KEY]: contextIdentitySchema
  })
  .strict();

export type InvokeContextMeta = z.infer<typeof contextIdentitySchema>;

export { artifactRefSchema };
