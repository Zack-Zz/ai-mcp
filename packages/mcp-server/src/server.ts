import { closeHttpListener, trackHttpListener } from '@ai-mcp/shared';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import {
  createInvocationId,
  createTraceId,
  isJsonObject,
  McpError,
  normalizeError,
  rpcRequestSchema,
  type InvocationContext,
  type InvocationFault,
  type InvocationOutcome,
  type McpErrorShape,
  type PromptName,
  type ResourceName,
  type RpcRequest
} from '@ai-mcp/shared';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type {
  Middleware,
  PromptDefinition,
  ResourceDefinition,
  RpcOutput,
  ToolDefinition
} from './types.js';
import { builtInPrompts, builtInResources, echoTool, timeTool } from './tools.js';
import { ToolRegistry, type RegistrySnapshot } from './tool-registry.js';
import { ToolDispatcher } from './tool-dispatcher.js';
import { createProtocolInstance } from './sdk-server-factory.js';
import { DEFAULT_SHUTDOWN_GRACE_MS, McpHttpLifecycle } from './lifecycle/http-lifecycle.js';

export type CreateServerOptions = {
  includeBuiltInTools?: boolean;
  /** Per-call deadline covering validation, handler execution and cleanup. */
  callTimeoutMs?: number;
  tenantId?: string;
  shutdownGraceMs?: number;
};

export type StartHttpOptions = {
  port: number;
  /** Default stateless: one SDK pair per request. 'stateful' adds sessions. */
  sessionMode?: 'stateful' | 'stateless';
  sessionIdleTimeoutMs?: number;
  maxSessions?: number;
  maxBodySizeBytes?: number;
  shutdownGraceMs?: number;
  /** Policy hook over the initialize body protocolVersion. */
  validateInitializeVersion?: (version: unknown) => { ok: true } | { ok: false; message: string };
};

export type StartSseOptions = {
  port: number;
  path?: string;
};

const HTTP_RPC_PATH = '/mcp';
const SERVER_INFO = { name: 'ai-mcp-server', version: '0.1.0' } as const;
type SdkTransport = Parameters<SdkMcpServer['connect']>[0];

/** Legacy four-code mapping used only by the handleRawRequest presenter. */
function faultToLegacyError(fault: InvocationFault): McpErrorShape {
  const code: McpErrorShape['code'] =
    fault.category === 'invalid_params' || fault.category === 'invalid_request'
      ? 'INVALID_PARAMS'
      : fault.category === 'cancelled' || fault.category === 'backend_timeout'
        ? 'TIMEOUT'
        : fault.category === 'policy_denied'
          ? 'UNAUTHORIZED'
          : 'INTERNAL';
  return {
    code,
    message: fault.message,
    traceId: fault.traceId,
    ...(fault.details !== undefined ? { details: fault.details as unknown } : {})
  };
}

/**
 * Business facade: owns the registry, middlewares and resource/prompt
 * definitions at service level. Protocol instances (SDK server + transport
 * pairs) are created per connection/request and share this kernel.
 */
export class McpServer {
  private readonly registry = new ToolRegistry();
  private readonly middlewares: Middleware[] = [];
  private readonly resources = new Map<ResourceName, ResourceDefinition<unknown, unknown>>();
  private readonly prompts = new Map<PromptName, PromptDefinition<unknown, unknown>>();
  private readonly options: CreateServerOptions;
  private readonly activeInstances = new Set<SdkMcpServer>();
  private readonly shutdownController = new AbortController();
  private dispatcher: ToolDispatcher | null = null;
  private lifecycleState: 'building' | 'serving' | 'closed' = 'building';
  private httpLifecycles: McpHttpLifecycle[] = [];
  private readonly listeners: Array<ReturnType<typeof createHttpServer>> = [];
  private shutdownGraceMs: number | undefined;

  public constructor(options: CreateServerOptions = {}) {
    this.options = options;
    this.shutdownGraceMs = options.shutdownGraceMs;
    if (options.includeBuiltInTools ?? true) {
      this.registerTool(echoTool);
      this.registerTool(timeTool);
      for (const resource of builtInResources) {
        this.registerResource(resource);
      }
      for (const prompt of builtInPrompts) {
        this.registerPrompt(prompt);
      }
    }
  }

  public registerTool<TInput, TOutput>(tool: ToolDefinition<TInput, TOutput>): void {
    this.assertNotClosed();
    this.registry.register(tool);
  }

  public use(middleware: Middleware): void {
    this.assertNotClosed();
    this.middlewares.push(middleware);
  }

  public registerResource<TParams, TOutput>(resource: ResourceDefinition<TParams, TOutput>): void {
    this.assertNotClosed();
    if (this.resources.has(resource.name)) {
      throw new McpError('INVALID_PARAMS', `Resource already registered: ${resource.name}`);
    }
    this.resources.set(resource.name, resource as ResourceDefinition<unknown, unknown>);
  }

  public registerPrompt<TArgs, TOutput>(prompt: PromptDefinition<TArgs, TOutput>): void {
    this.assertNotClosed();
    if (this.prompts.has(prompt.name)) {
      throw new McpError('INVALID_PARAMS', `Prompt already registered: ${prompt.name}`);
    }
    this.prompts.set(prompt.name, prompt as PromptDefinition<unknown, unknown>);
  }

  public listTools(): { name: string; description: string }[] {
    return this.registry.listBrief();
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

  /**
   * Connects a brand-new protocol instance (SDK server + this transport) to
   * the shared kernel. One instance owns one transport for its lifetime.
   */
  public async connect(transport: SdkTransport): Promise<void> {
    const instance = this.createProtocolInstance();
    try {
      await instance.connect(transport);
    } catch (error) {
      this.activeInstances.delete(instance);
      await instance.close().catch(() => undefined);
      throw error;
    }
  }

  /** Compatibility path for unit tests and legacy in-memory invocation. */
  public async handleRawRequest(raw: unknown): Promise<RpcOutput> {
    this.assertNotClosed();
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
      if (parsed.method === 'tools/call') {
        const params = parseLegacyToolCallParams(parsed.params);
        const outcome = await this.getDispatcher().invoke(
          params.name,
          params.input,
          this.legacyInvocationContext(traceId)
        );
        return this.presentLegacyOutcome(parsed.id, outcome);
      }

      await this.runListMiddlewares({ traceId, method: parsed.method });
      if (parsed.method === 'tools/list') {
        return { id: parsed.id, result: { tools: this.listTools() } };
      }
      if (parsed.method === 'resources/list') {
        return { id: parsed.id, result: { resources: this.listResources() } };
      }
      if (parsed.method === 'prompts/list') {
        return { id: parsed.id, result: { prompts: this.listPrompts() } };
      }
      throw new McpError('INVALID_PARAMS', `Unsupported method: ${parsed.method}`, traceId);
    } catch (error) {
      return { id: parsed.id, error: normalizeError(error, traceId) };
    }
  }

  public startStdio(): void {
    const transport = new StdioServerTransport() as SdkTransport;
    void this.connect(transport);
  }

  public startHttp(options: StartHttpOptions): ReturnType<typeof createHttpServer> {
    this.assertNotClosed();
    if (options.shutdownGraceMs !== undefined) this.shutdownGraceMs = options.shutdownGraceMs;
    const lifecycle = new McpHttpLifecycle({
      createInstance: () => this.createProtocolInstance(),
      sessionMode: options.sessionMode ?? 'stateless',
      ...(options.sessionIdleTimeoutMs !== undefined
        ? { sessionIdleTimeoutMs: options.sessionIdleTimeoutMs }
        : {}),
      ...(options.maxSessions !== undefined ? { maxSessions: options.maxSessions } : {}),
      ...(options.maxBodySizeBytes !== undefined
        ? { maxBodySizeBytes: options.maxBodySizeBytes }
        : {}),
      ...(options.validateInitializeVersion !== undefined
        ? { validateInitializeVersion: options.validateInitializeVersion }
        : {}),
      onInstanceClosed: (instance) => {
        this.activeInstances.delete(instance);
      }
    });
    this.httpLifecycles.push(lifecycle);

    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (this.lifecycleState === 'closed') {
        res.writeHead(503, { connection: 'close' });
        res.end();
        return;
      }
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
        await lifecycle.handleRequest(req, res);
      } catch {
        if (!res.headersSent && !res.destroyed) {
          res.writeHead(500);
          res.end();
        }
      }
    });

    trackHttpListener(httpServer);
    httpServer.listen(options.port);
    this.listeners.push(httpServer);
    return httpServer;
  }

  public startSse(options: StartSseOptions): ReturnType<typeof createHttpServer> {
    this.assertNotClosed();
    const path = options.path ?? '/sse';
    const sseEntries = new Map<string, { transport: SSEServerTransport; instance: SdkMcpServer }>();

    const httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (this.lifecycleState === 'closed') {
        res.writeHead(503, { connection: 'close' });
        res.end();
        return;
      }
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (req.method === 'GET' && req.url === path) {
        // One SSE session owns its own SDK server/transport pair.
        const transport = new SSEServerTransport(`${path}/call`, res);
        const instance = this.createProtocolInstance();
        sseEntries.set(transport.sessionId, { transport, instance });
        transport.onclose = () => {
          sseEntries.delete(transport.sessionId);
          this.activeInstances.delete(instance);
        };

        try {
          await instance.connect(transport as SdkTransport);
        } catch (error) {
          sseEntries.delete(transport.sessionId);
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

        const entry = sseEntries.get(sessionId);
        if (!entry) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'SSE session not found' }));
          return;
        }

        await entry.transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    trackHttpListener(httpServer);
    httpServer.listen(options.port);
    this.listeners.push(httpServer);
    return httpServer;
  }

  /** Protocol instances currently owned (sessions, requests, stdio, SSE). */
  public get activeProtocolInstanceCount(): number {
    return this.activeInstances.size;
  }

  public supports(transport: 'stdio' | 'http' | 'sse'): boolean {
    return ['stdio', 'http', 'sse'].includes(transport);
  }

  /** Closes all protocol instances and listeners; idempotent and terminal. */
  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeService();
    return this.closePromise;
  }

  private async closeService(): Promise<void> {
    this.lifecycleState = 'closed';
    this.shutdownController.abort(new DOMException('Server shutting down', 'AbortError'));
    const graceMs = this.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
    const listeners = this.listeners.splice(0);
    const closingListeners = listeners.map((listener) => closeHttpListener(listener, graceMs));
    await Promise.allSettled(this.httpLifecycles.map((lifecycle) => lifecycle.close(graceMs)));
    this.httpLifecycles = [];
    // Close protocol instances BEFORE listeners: instance close terminates
    // live response streams (SSE/GET), which is what lets listener.close()
    // ever complete; the reverse order deadlocks on open sockets.
    const instances = Array.from(this.activeInstances);
    this.activeInstances.clear();
    await Promise.allSettled(instances.map((instance) => instance.close()));
    listeners.forEach((listener) => listener.closeIdleConnections());
    await Promise.allSettled(closingListeners);
  }

  private closePromise: Promise<void> | undefined;

  private createProtocolInstance(): SdkMcpServer {
    this.assertNotClosed();
    this.lifecycleState = 'serving';
    const snapshot = this.registry.freeze();
    const instance = createProtocolInstance({
      snapshot,
      dispatcher: this.getDispatcher(),
      resources: Array.from(this.resources.values()),
      prompts: Array.from(this.prompts.values()),
      serverInfo: { ...SERVER_INFO },
      serviceSignal: this.shutdownController.signal,
      ...(this.options.tenantId !== undefined ? { tenantId: this.options.tenantId } : {}),
      ...(this.options.callTimeoutMs !== undefined
        ? { callTimeoutMs: this.options.callTimeoutMs }
        : {})
    });
    instance.server.onclose = () => this.activeInstances.delete(instance);
    this.activeInstances.add(instance);
    return instance;
  }

  private getDispatcher(): ToolDispatcher {
    if (!this.dispatcher) {
      const snapshot: RegistrySnapshot = this.registry.freeze();
      this.dispatcher = new ToolDispatcher(snapshot, this.middlewares);
    }
    return this.dispatcher;
  }

  private legacyInvocationContext(traceId: string): InvocationContext {
    return {
      invocationId: createInvocationId(),
      traceId,
      peerEra: 'legacy',
      protocolVersion: '2025-03-26',
      deadlineAt:
        (this.options.callTimeoutMs ?? 60_000) > 0
          ? Date.now() + (this.options.callTimeoutMs ?? 60_000)
          : Number.MAX_SAFE_INTEGER,
      signal: this.shutdownController.signal,
      actor: { tenantId: this.options.tenantId ?? 'default' }
    };
  }

  private presentLegacyOutcome(id: string, outcome: InvocationOutcome): RpcOutput {
    if (outcome.kind === 'success') {
      const output = outcome.result.structuredContent;
      return {
        id,
        result: { output: isJsonObject(output) ? output : {} }
      };
    }
    return { id, error: faultToLegacyError(outcome.fault) };
  }

  private async runListMiddlewares(ctx: {
    traceId: string;
    method: 'tools/list' | 'resources/list' | 'prompts/list';
  }): Promise<void> {
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
      await middleware(ctx, async () => runner(position + 1));
    };
    await runner(0);
  }

  private assertNotClosed(): void {
    if (this.lifecycleState === 'closed') {
      throw new McpError('INVALID_PARAMS', 'Server is closed');
    }
  }
}

function parseLegacyToolCallParams(params: unknown): { name: string; input: unknown } {
  if (!isJsonObject(params)) {
    throw new McpError('INVALID_PARAMS', 'Invalid tools/call params');
  }
  const name = params.name;
  if (typeof name !== 'string' || name.length === 0) {
    throw new McpError('INVALID_PARAMS', 'Tool name must be a non-empty string');
  }
  return { name, input: params.input };
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  return new McpServer(options);
}
