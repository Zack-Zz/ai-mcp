import {
  SchemaCompileError,
  SchemaCompiler,
  toolDescriptorSchema,
  type CompiledSchema,
  type ToolDescriptor
} from '@ai-mcp/shared';
import { McpClientError } from './errors.js';

export const DEFAULT_MAX_DISCOVERY_PAGES = 128;

export type DiscoveredTool = {
  descriptor: ToolDescriptor;
  inputValidator: CompiledSchema;
  outputValidator?: CompiledSchema | undefined;
};

export type DiscoveryCatalog = {
  /** Snapshot revision token (fingerprint of the discovered set). */
  revision: string;
  tools: Map<string, DiscoveredTool>;
  descriptors: ToolDescriptor[];
};

export type ListToolsPageRequester = (params: {
  cursor?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) => Promise<{ tools: unknown[]; nextCursor?: string }>;

/**
 * Full pagination: fetch every page, validate each descriptor, detect
 * duplicate names and looping cursors, compile validators, and return the
 * complete catalog. Any failure means discovery failed - a truncated result
 * is never reported as complete.
 */
export async function discoverAllTools(
  requestPage: ListToolsPageRequester,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    maxPages?: number;
  }
): Promise<DiscoveryCatalog> {
  const compiler = new SchemaCompiler();
  const maxPages = options.maxPages ?? DEFAULT_MAX_DISCOVERY_PAGES;
  const seenCursors = new Set<string>();
  const names = new Set<string>();
  const descriptors: ToolDescriptor[] = [];
  const tools = new Map<string, DiscoveredTool>();

  let cursor: string | undefined = undefined;
  let pages = 0;
  const deadlineAt = Date.now() + options.timeoutMs;

  for (;;) {
    if (pages >= maxPages) {
      throw new McpClientError(
        'internal',
        'INTERNAL',
        `Tool discovery exceeded the maximum page count (${maxPages}) without completing`
      );
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0)
      throw new McpClientError(
        'backend_timeout',
        'BACKEND_TIMEOUT',
        'Tool discovery deadline exceeded'
      );
    options.signal?.throwIfAborted();
    const page = await requestPage({
      ...(cursor !== undefined ? { cursor } : {}),
      timeoutMs: remainingMs,
      ...(options.signal ? { signal: options.signal } : {})
    });
    pages += 1;

    for (const rawTool of page.tools) {
      const parsed = toolDescriptorSchema.safeParse(rawTool);
      if (!parsed.success) {
        throw new McpClientError(
          'invalid_params',
          'INVALID_PARAMS',
          `Downstream advertised an invalid tool descriptor: ${parsed.error.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ')}`
        );
      }
      if (names.has(parsed.data.name)) {
        throw new McpClientError(
          'invalid_params',
          'INVALID_PARAMS',
          `Duplicate tool name discovered across pages: ${parsed.data.name}`
        );
      }
      let inputValidator;
      let outputValidator;
      try {
        inputValidator = compiler.compile(parsed.data.inputSchema);
        outputValidator = parsed.data.outputSchema
          ? compiler.compile(parsed.data.outputSchema)
          : undefined;
      } catch (error) {
        const compileError = error instanceof SchemaCompileError ? error : undefined;
        throw new McpClientError(
          'invalid_params',
          'INVALID_PARAMS',
          `Tool ${parsed.data.name} advertises an unusable inputSchema: ${
            compileError?.message ?? (error instanceof Error ? error.message : String(error))
          }`,
          { toolName: parsed.data.name, ...(compileError ? { code: compileError.code } : {}) }
        );
      }
      names.add(parsed.data.name);
      descriptors.push(parsed.data);
      tools.set(parsed.data.name, { descriptor: parsed.data, inputValidator, outputValidator });
    }

    if (page.nextCursor === undefined) {
      break;
    }
    if (seenCursors.has(page.nextCursor)) {
      throw new McpClientError(
        'internal',
        'INTERNAL',
        `Tool discovery cursor loop detected: ${page.nextCursor}`
      );
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  const revision = `${descriptors.length}:${descriptors
    .map((tool) => tool.name)
    .sort()
    .join(',')}`;
  return { revision, tools, descriptors };
}
