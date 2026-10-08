import { Client as SdkClient } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  CallToolRequest,
  CallToolResultSchema,
  ListToolsRequest,
  ListToolsResultSchema
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  isJsonObject,
  createTraceId,
  awaitWithSignal,
  standardToolResultEnvelopeSchema,
  invokeContextMetaSchema,
  toolSchemas,
  type JsonObject,
  type NativeToolResult,
  type ResultContract,
  type ToolDescriptor,
  type ToolInputMap,
  type ToolName,
  type ToolOutputMap,
  type TransportKind
} from '@ai-mcp/shared';
import type { ZodType } from 'zod';
import { pinProtocolVersion } from './adapters/legacy-client.js';
import { classifySdkClientError, McpClientError } from './errors.js';
import { discoverAllTools, type DiscoveryCatalog } from './discovery.js';
import {
  decodeTextJsonFallback,
  describeToolFailure,
  firstTextBlock,
  toNativeToolResult
} from './result-decoder.js';

export type CreateClientOptions = {
  transport: TransportKind;
  endpoint?: string;
  timeoutMs?: number;
  protocolVersion?: string;
};

export type CallOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  context?: Readonly<{ traceId?: string; runId?: string; taskId?: string }>;
  /** Effective adapter contract; explicit caller policy takes precedence over discovery. */
  resultContract?: ResultContract;
};

export type McpClientOptions = {
  timeoutMs?: number;
  connectTimeoutMs?: number;
  requestTimeoutMs?: number;
};

type SdkTransport = Parameters<SdkClient['connect']>[0];

const TERMINATE_SESSION_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpClientError('backend_timeout', 'BACKEND_TIMEOUT', `${what} timed out`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * Public SDK facade over one transport. Keeps the legacy brief listTools and
 * the demo callTool generics, and adds the generic discovery / native-result
 * / validated-tool APIs used by the CLI and the gateway connectors.
 */
export class McpClient {
  private readonly timeoutMs: number;
  private readonly connectTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sdkClient: SdkClient;
  private connectPromise: Promise<void> | undefined = undefined;
  private closePromise: Promise<void> | undefined = undefined;
  private closed = false;
  private connected = false;
  private transportClosed = false;
  private readonly shutdownController = new AbortController();
  private permanentFailure: McpClientError | null = null;
  private catalog: DiscoveryCatalog | null = null;

  public constructor(
    private readonly transport: SdkTransport,
    options: number | McpClientOptions = 10000
  ) {
    const resolved: McpClientOptions =
      typeof options === 'number' ? { timeoutMs: options } : options;
    this.timeoutMs = resolved.timeoutMs ?? 10000;
    this.connectTimeoutMs = resolved.connectTimeoutMs ?? this.timeoutMs;
    this.requestTimeoutMs = resolved.requestTimeoutMs ?? this.timeoutMs;
    this.sdkClient = new SdkClient({
      name: 'ai-mcp-client',
      version: '0.1.0'
    });
    this.sdkClient.onclose = () => {
      this.transportClosed = true;
      // A completed handshake promise is not evidence of a live transport.
      // This facade owns one transport; the connector owns its replacement.
      if (this.connected && !this.closed) {
        this.permanentFailure = new McpClientError(
          'backend_unavailable',
          'BACKEND_UNAVAILABLE',
          'Downstream connection closed',
          undefined,
          true
        );
        this.connectPromise = undefined;
      }
      this.connected = false;
      this.catalog = null;
    };
  }

  public get isConnected(): boolean {
    return this.connected && !this.closed && this.permanentFailure === null;
  }

  /** Explicit connect with a bounded deadline; safe to call repeatedly. */
  public async connect(): Promise<void> {
    await this.ensureConnected();
  }

  public async listTools(): Promise<{ name: string; description: string }[]> {
    this.assertNotClosed();
    await this.ensureConnected();
    try {
      const response = await this.sdkClient.listTools(undefined, {
        timeout: this.requestTimeoutMs
      });
      return response.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? ''
      }));
    } catch (error) {
      throw classifySdkClientError(error, 'request');
    }
  }

  /**
   * Full discovery: consumes all pages, keeps complete descriptors
   * (schemas, annotations, titles, icons, _meta) and refreshes the cache on
   * every explicit call.
   */
  public async discoverTools(options?: CallOptions): Promise<readonly ToolDescriptor[]> {
    this.assertNotClosed();
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      deadline.signal,
      this.shutdownController.signal,
      ...(options?.signal ? [options.signal] : [])
    ]);
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const deadlineAt = Date.now() + timeoutMs;
    const timer = setTimeout(
      () => deadline.abort(new DOMException('Tool discovery deadline exceeded', 'TimeoutError')),
      timeoutMs
    );
    try {
      signal.throwIfAborted();
      await awaitWithSignal(this.ensureConnected(), signal);
      signal.throwIfAborted();
      const catalog = await awaitWithSignal(
        this.runDiscovery({ ...options, timeoutMs: Math.max(1, deadlineAt - Date.now()), signal }),
        signal
      );
      signal.throwIfAborted();
      // Failed or cancelled discovery never replaces the validated cache.
      this.catalog = catalog;
      return catalog.descriptors;
    } catch (error) {
      if (signal.aborted)
        throw new McpClientError(
          deadline.signal.aborted ? 'backend_timeout' : 'cancelled',
          deadline.signal.aborted ? 'BACKEND_TIMEOUT' : 'CANCELLED',
          deadline.signal.aborted ? 'Tool discovery deadline exceeded' : 'Tool discovery cancelled'
        );
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Generic call returning the native semantic result. isError results are
   * returned as tool failures for the caller to inspect; protocol and
   * transport failures throw classified McpClientError.
   */
  public async callToolResult(
    name: string,
    args: JsonObject,
    options?: CallOptions
  ): Promise<NativeToolResult> {
    this.assertNotClosed();
    const deadline = new AbortController();
    const signal = AbortSignal.any([
      deadline.signal,
      this.shutdownController.signal,
      ...(options?.signal ? [options.signal] : [])
    ]);
    const timeoutMs = options?.timeoutMs ?? this.requestTimeoutMs;
    const timer =
      timeoutMs > 0
        ? setTimeout(
            () => deadline.abort(new DOMException('Tool call deadline exceeded', 'TimeoutError')),
            timeoutMs
          )
        : undefined;
    try {
      signal.throwIfAborted();
      return await awaitWithSignal(
        this.callToolResultWithinBudget(name, args, { ...options, timeoutMs, signal }),
        signal
      );
    } catch (error) {
      if (signal.aborted)
        throw new McpClientError(
          deadline.signal.aborted ? 'backend_timeout' : 'cancelled',
          deadline.signal.aborted ? 'BACKEND_TIMEOUT' : 'CANCELLED',
          deadline.signal.aborted
            ? `Tool call ${name} deadline exceeded`
            : `Tool call ${name} cancelled`
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async callToolResultWithinBudget(
    name: string,
    args: JsonObject,
    options: CallOptions
  ): Promise<NativeToolResult> {
    this.assertNotClosed();
    await awaitWithSignal(this.ensureConnected(), options.signal);
    options.signal?.throwIfAborted();
    const entry = (await this.ensureCatalog(options)).tools.get(name);
    if (entry) {
      const inputCheck = entry.inputValidator.validate(args);
      if (!inputCheck.valid) {
        throw new McpClientError(
          'invalid_params',
          'INVALID_PARAMS',
          `Invalid input for tool ${name}: ${inputCheck.issues
            .map((issue) => `${issue.path || '(root)'} ${issue.message}`)
            .join('; ')}`,
          { toolName: name, issues: inputCheck.issues as unknown as JsonObject[] }
        );
      }
    }

    options.signal?.throwIfAborted();
    const request: CallToolRequest['params'] & { _meta?: Record<string, unknown> } = {
      name,
      arguments: args as Record<string, unknown>
    };
    if (options?.context) {
      const metadata = invokeContextMetaSchema.safeParse({
        'org.ai-mcp/context': {
          ...options.context,
          traceId: options.context.traceId ?? createTraceId()
        }
      });
      if (!metadata.success)
        throw new McpClientError('invalid_params', 'INVALID_PARAMS', 'Invalid invocation context');
      request._meta = metadata.data;
    }

    let raw: unknown;
    try {
      raw = await this.sdkClient.request(
        { method: 'tools/call', params: request },
        CallToolResultSchema,
        {
          timeout: options?.timeoutMs ?? this.requestTimeoutMs,
          ...(options?.signal ? { signal: options.signal } : {})
        }
      );
    } catch (error) {
      // The SDK wraps caller aborts as -32001 timeout-shaped errors; the
      // signal state is the authoritative discriminator, not the text.
      if (options?.signal?.aborted) {
        throw new McpClientError(
          'cancelled',
          'CANCELLED',
          `Tool call ${name} was cancelled: ${
            options.signal.reason instanceof Error
              ? options.signal.reason.message
              : String(options.signal.reason ?? 'aborted by caller')
          }`
        );
      }
      throw classifySdkClientError(error, 'request');
    }

    const native = toNativeToolResult(raw);

    // Error first: an isError result is the tool's failure and is never run
    // through the success output schema.
    if (native.isError) {
      return native;
    }

    const contract =
      options.resultContract ?? entry?.descriptor._meta?.['org.ai-mcp/result-contract'];
    if (contract === 'standard/v1' || contract === 'legacy-auto') {
      // Text JSON is the old protocol compatibility path only when no
      // structured success schema has been advertised.
      const payload =
        native.structuredContent ??
        (!entry?.outputValidator ? decodeTextJsonFallback(native) : undefined);
      const envelope = standardToolResultEnvelopeSchema.safeParse(payload);
      if (!envelope.success && contract === 'standard/v1')
        throw new McpClientError(
          'invalid_result',
          'INVALID_RESULT',
          `Tool ${name} returned an invalid standard envelope`
        );
      if (envelope.success && !envelope.data.ok) return { ...native, isError: true };
    }

    if (entry?.outputValidator) {
      if (native.structuredContent === undefined) {
        throw new McpClientError(
          'invalid_result',
          'INVALID_RESULT',
          `Tool ${name} declared an output schema but returned no structuredContent`,
          { toolName: name }
        );
      }
      const outputCheck = entry.outputValidator.validate(native.structuredContent);
      if (!outputCheck.valid) {
        throw new McpClientError(
          'invalid_result',
          'INVALID_RESULT',
          `Tool ${name} returned a success payload that violates its declared output schema: ${outputCheck.issues
            .map((issue) => `${issue.path || '(root)'} ${issue.message}`)
            .join('; ')}`,
          { toolName: name, issues: outputCheck.issues as unknown as JsonObject[] }
        );
      }
    }
    return native;
  }

  /**
   * Typed helper: fails the call on native isError, then decodes
   * (structuredContent first, legacy single-text JSON fallback second) and
   * parses through the caller's schema. No unchecked generic passthrough.
   */
  public async callValidatedTool<T>(
    name: string,
    args: JsonObject,
    outputSchema: ZodType<T>,
    options?: CallOptions
  ): Promise<T> {
    const result = await this.callToolResult(name, args, options);
    if (result.isError) {
      throw new McpClientError('tool_failure', 'TOOL_FAILED', describeToolFailure(result, name), {
        toolName: name,
        content: result.content
      });
    }
    const payload =
      result.structuredContent !== undefined
        ? result.structuredContent
        : decodeTextJsonFallback(result);
    if (payload === undefined) {
      const text = firstTextBlock(result);
      throw new McpClientError(
        'invalid_result',
        'INVALID_RESULT',
        `Tool ${name} returned no decodable payload${text ? ` (text: ${text.slice(0, 120)})` : ''}`,
        { toolName: name, contentTypes: result.content.map((block) => String(block.type)) }
      );
    }
    const parsed = outputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new McpClientError(
        'invalid_result',
        'INVALID_RESULT',
        `Tool ${name} returned a payload that does not match the expected output: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
          .join('; ')}`,
        { toolName: name }
      );
    }
    return parsed.data;
  }

  /**
   * Legacy demo API. Error-first ordering and runtime input/output checks
   * are new; the returned data shape and error texts stay compatible.
   */
  public async callTool<TName extends ToolName>(
    name: TName,
    input: ToolInputMap[TName]
  ): Promise<ToolOutputMap[TName]> {
    await this.ensureConnected();

    const inputCheck = toolSchemas[name].input.safeParse(input);
    if (!inputCheck.success) {
      throw new Error(
        `Invalid input for tool ${name}: ${inputCheck.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }

    let response: unknown;
    try {
      response = await this.sdkClient.callTool(
        { name, arguments: input as Record<string, unknown> },
        undefined,
        { timeout: this.requestTimeoutMs }
      );
    } catch (error) {
      throw classifySdkClientError(error, 'request');
    }

    const textBlock = extractTextBlock(response);
    if ((response as { isError?: boolean }).isError === true) {
      if (textBlock) {
        throw new Error(textBlock);
      }
      throw new Error('Tool call failed');
    }

    const structured = (response as { structuredContent?: unknown }).structuredContent;
    let payload: unknown;
    if (structured !== undefined) {
      payload = structured;
    } else if (textBlock) {
      try {
        payload = JSON.parse(textBlock);
      } catch {
        throw new Error(textBlock);
      }
    } else {
      throw new Error('Invalid tool call response');
    }

    const outputCheck = toolSchemas[name].output.safeParse(payload);
    if (!outputCheck.success) {
      throw new Error(
        `Invalid output for tool ${name}: ${outputCheck.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`
      );
    }
    return outputCheck.data as ToolOutputMap[TName];
  }

  /** Idempotent close: terminates a stateful HTTP session first when held. */
  public async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closed = true;
    this.shutdownController.abort(new DOMException('Client closed', 'AbortError'));
    this.closePromise = (async () => {
      const maybeSessionCapable = this.transport as {
        terminateSession?: () => Promise<boolean>;
      };
      if (typeof maybeSessionCapable.terminateSession === 'function' && !this.permanentFailure) {
        try {
          await withTimeout(
            maybeSessionCapable.terminateSession(),
            TERMINATE_SESSION_TIMEOUT_MS,
            'Session termination'
          );
        } catch {
          // 405 or an already-expired session: the server-side TTL still
          // owns cleanup; proceed with the local close.
        }
      }
      this.closed = true;
      await this.sdkClient.close();
      // A connecting transport is also owned by this instance. SDK close
      // rejects the handshake; wait for its final cleanup before returning.
      await this.connectPromise?.catch(() => undefined);
    })();
    return this.closePromise;
  }

  private async ensureConnected(): Promise<void> {
    this.assertNotClosed();
    if (this.permanentFailure) {
      throw this.permanentFailure;
    }
    if (!this.connectPromise) {
      this.connectPromise = this.attemptConnect();
    }
    await this.connectPromise;
    this.assertNotClosed();
    if (this.permanentFailure) throw this.permanentFailure;
  }

  private async attemptConnect(): Promise<void> {
    this.transportClosed = false;
    try {
      await withTimeout(
        this.sdkClient.connect(this.transport),
        this.connectTimeoutMs,
        'Connecting to downstream MCP'
      );
      this.assertNotClosed();
      if (this.transportClosed) {
        throw new McpClientError(
          'backend_unavailable',
          'BACKEND_UNAVAILABLE',
          'Downstream connection closed during initialization',
          undefined,
          true
        );
      }
      this.connected = true;
    } catch (error) {
      this.connectPromise = undefined;
      const classified = classifySdkClientError(error, 'connect');
      if (classified.permanent) {
        this.permanentFailure = classified;
      }
      await this.sdkClient.close().catch(() => undefined);
      throw classified;
    }
  }

  private async ensureCatalog(options?: CallOptions): Promise<DiscoveryCatalog> {
    if (!this.catalog) {
      try {
        this.catalog = await this.runDiscovery(options);
      } catch (error) {
        // Servers without the tools capability (or rejecting tools/list as a
        // method) still accept direct calls; proceed without schema checks.
        if (
          error instanceof McpClientError &&
          error.category === 'invalid_request' &&
          error.details?.jsonRpcCode === -32601
        ) {
          this.catalog = { revision: 'none', tools: new Map(), descriptors: [] };
        } else {
          throw error;
        }
      }
    }
    return this.catalog;
  }

  private assertNotClosed(): void {
    if (this.closed) {
      throw new McpClientError('backend_unavailable', 'BACKEND_UNAVAILABLE', 'Client is closed');
    }
  }

  private async runDiscovery(options?: CallOptions): Promise<DiscoveryCatalog> {
    if (this.closed) {
      throw new McpClientError('backend_unavailable', 'BACKEND_UNAVAILABLE', 'Client is closed');
    }
    try {
      return await discoverAllTools(
        async (page) => {
          const params: ListToolsRequest['params'] = {
            ...(page.cursor !== undefined ? { cursor: page.cursor } : {})
          };
          const response = await this.sdkClient.request(
            { method: 'tools/list', params },
            ListToolsResultSchema,
            {
              timeout: page.timeoutMs,
              ...(page.signal ? { signal: page.signal } : {})
            }
          );
          return {
            tools: response.tools as unknown[],
            ...(response.nextCursor !== undefined ? { nextCursor: response.nextCursor } : {})
          };
        },
        {
          timeoutMs: options?.timeoutMs ?? this.requestTimeoutMs,
          ...(options?.signal ? { signal: options.signal } : {})
        }
      );
    } catch (error) {
      if (error instanceof McpClientError) {
        throw error;
      }
      throw classifySdkClientError(error, 'request');
    }
  }
}

function extractTextBlock(response: unknown): string | undefined {
  const content = (response as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  const block = content.find(
    (item): item is { type: string; text: string } =>
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'text' &&
      typeof (item as { text?: unknown }).text === 'string'
  );
  return block?.text;
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

  let transport: Transport;
  switch (options.transport) {
    case 'http': {
      // The SDK class types its optional callback slots as `| undefined`,
      // which is not directly assignable under exactOptionalPropertyTypes;
      // the instance genuinely implements Transport.
      transport = new StreamableHTTPClientTransport(
        new URL(options.endpoint!)
      ) as unknown as Transport;
      break;
    }
    case 'sse': {
      const endpoint = options.endpoint!;
      const normalizedEndpoint = endpoint.endsWith('/call') ? endpoint.slice(0, -5) : endpoint;
      transport = new SSEClientTransport(new URL(normalizedEndpoint));
      break;
    }
    case 'stdio': {
      const stdioCommand = parseCommand(options.endpoint!);
      transport = new StdioClientTransport({
        command: stdioCommand.command,
        args: stdioCommand.args
      }) as unknown as Transport;
      break;
    }
    default:
      throw new Error(`Unsupported transport: ${options.transport}`);
  }

  if (options.protocolVersion && options.transport === 'http') {
    // The pinned version rides in the initialize request body; headers after
    // the handshake always follow the negotiated version.
    return pinProtocolVersion(transport as Transport, options.protocolVersion) as SdkTransport;
  }
  return transport;
}

export function createClient(options: CreateClientOptions): McpClient {
  return new McpClient(createTransport(options), options.timeoutMs ?? 10000);
}

export { isJsonObject, McpClientError, classifySdkClientError };
