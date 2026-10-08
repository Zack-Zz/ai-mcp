import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import {
  CONTEXT_META_KEY,
  createInvocationId,
  createTraceId,
  awaitWithSignal,
  invokeContextMetaSchema,
  isJsonObject,
  readBoundedHttpBody,
  closeHttpListener,
  trackHttpListener,
  type InvocationContext,
  type FaultSource,
  type JsonObject,
  type StandardToolResult
} from '@ai-mcp/shared';
import { Server as SdkServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  CallToolResultSchema,
  ListToolsRequestSchema,
  ToolSchema,
  McpError as SdkMcpError,
  type CallToolResult,
  type Tool
} from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import { McpGatewayCore } from './gateway-core.js';
import type {
  AuditEvent,
  AuditOutcome,
  BackendSpec,
  GatewayServerOptions,
  StartGatewayHttpOptions
} from './types.js';
import { InMemoryAuditStore } from './audit.js';
import { GatewayPolicyEngine } from './policy.js';
import { resolveProtocolVersion } from './protocol.js';
import { hashInputPayload } from './audit-hash.js';
import { GatewayCapabilityRegistry } from './capability-registry.js';
import { DownstreamConnectorError } from './connectors/base.js';
import { connectorInvocationFault } from './connectors/result.js';
import type { CatalogEntry } from './tool-catalog.js';
import { adaptDownstreamResult } from './result-adapter.js';

const HTTP_RPC_PATH = '/mcp';
const RATE_LIMITED_ERROR_CODE = -32010;
const POLICY_DENIED_ERROR_CODE = -32020;
const BACKEND_UNAVAILABLE_ERROR_CODE = -32030;
const BACKEND_TIMEOUT_ERROR_CODE = -32040;

const LEGACY_ERROR_CODE_BY_CATEGORY: Record<string, number> = {
  rate_limited: RATE_LIMITED_ERROR_CODE,
  policy_denied: POLICY_DENIED_ERROR_CODE,
  backend_unavailable: BACKEND_UNAVAILABLE_ERROR_CODE,
  backend_timeout: BACKEND_TIMEOUT_ERROR_CODE
};

const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_MAX_SESSIONS = 256;
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Gateway upstream facade. The business catalog, policy engine, audit store
 * and downstream connectors are service-owned; every protocol instance
 * (stateful session or stdio process) is created fresh and binds to the
 * frozen catalog snapshot.
 */
export class McpGatewayServer {
  private readonly gatewayCore: McpGatewayCore;
  private readonly policyEngine: GatewayPolicyEngine;
  private readonly capabilityRegistry: GatewayCapabilityRegistry;
  private readonly auditStore: NonNullable<GatewayServerOptions['auditStore']>;
  private readonly tenantId: string;
  private readonly who: string | undefined;
  private readonly agent: string | undefined;
  private readonly runId: string | undefined;
  private readonly allowLegacyHttpSse: boolean;
  private readonly auditHashSecret: string | null;
  private readonly shutdownGraceMs: number;
  private readonly shutdownController = new AbortController();
  private readonly invocations = new Set<Promise<CallToolResult>>();
  private readonly serverInfo: { name: string; version: string };
  private readonly stdioServer: SdkServer | null = null;
  private readonly instances = new Set<SdkServer>();
  private readonly protocolVersions = new WeakMap<SdkServer, { version?: string }>();
  private initializePromise: Promise<void> | undefined;
  private readonly httpCleanups: Array<() => Promise<unknown>> = [];
  private readonly httpListeners: Array<ReturnType<typeof createHttpServer>> = [];
  private closePromise: Promise<void> | undefined;
  private lifecycle: 'new' | 'serving' | 'closed' = 'new';

  public constructor(backends: BackendSpec[], options: GatewayServerOptions = {}) {
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5000;
    this.gatewayCore = new McpGatewayCore(
      backends,
      options.connectorFactory,
      options.resultContracts
    );
    this.policyEngine = new GatewayPolicyEngine(options.policy);
    this.capabilityRegistry = new GatewayCapabilityRegistry(options.capabilities);
    this.auditStore = options.auditStore ?? new InMemoryAuditStore();
    this.tenantId = options.tenantId ?? 'default';
    this.who = options.who;
    this.agent = options.agent;
    this.runId = options.runContext?.runId;
    this.allowLegacyHttpSse = options.allowLegacyHttpSse ?? false;
    this.auditHashSecret = options.auditHashSecret ?? null;
    this.serverInfo = {
      name: options.name ?? 'ai-mcp-gateway',
      version: options.version ?? '0.1.0'
    };
  }

  /** Idempotent bootstrap; a failed discovery releases connected backends. */
  public async initialize(): Promise<void> {
    if (this.lifecycle === 'closed') throw new Error('Gateway is closed');
    if (this.initializePromise) {
      return this.initializePromise;
    }
    this.initializePromise = (async () => {
      try {
        await this.gatewayCore.refreshTools();
        if (this.lifecycle === 'closed') throw new Error('Gateway is closed');
        this.lifecycle = 'serving';
      } catch (error) {
        await this.gatewayCore.close();
        this.initializePromise = undefined;
        throw error;
      }
    })();
    return this.initializePromise;
  }

  public startStdio(): void {
    const instance = this.createProtocolInstance();
    const transport = new StdioServerTransport() as unknown as Transport;
    void this.connectProtocolInstance(instance, transport).catch(() => undefined);
  }

  /** Connects a fresh protocol instance to the given transport. */
  public async connect(transport: Transport): Promise<void> {
    const instance = this.createProtocolInstance();
    try {
      await this.connectProtocolInstance(instance, transport);
    } catch (error) {
      this.instances.delete(instance);
      await instance.close().catch(() => undefined);
      throw error;
    }
  }

  public startHttp(options: StartGatewayHttpOptions): ReturnType<typeof createHttpServer> {
    if (this.lifecycle === 'closed') throw new Error('Gateway is closed');
    const path = options.path ?? HTTP_RPC_PATH;
    const sessionMode = options.sessionMode ?? 'stateful';
    const idleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    const maxBodyBytes = options.maxBodySizeBytes ?? DEFAULT_MAX_BODY_BYTES;

    type GatewaySessionEntry = {
      sessionId: string;
      transport: StreamableHTTPServerTransport;
      instance: SdkServer;
      lastActiveAt: number;
      activeRequests: number;
      closeOnce: Promise<void> | null;
      closing: boolean;
      bodyReads: Set<{ controller: AbortController; response: ServerResponse }>;
    };

    const sessionEntries = new Map<string, GatewaySessionEntry>();
    type GatewayProtocolCandidate = {
      transport: StreamableHTTPServerTransport;
      instance: SdkServer;
      closeOnce: Promise<void> | null;
    };
    const pendingCandidates = new Set<GatewayProtocolCandidate>();
    let stopping = false;
    const bodyReads = new Set<{ controller: AbortController; response: ServerResponse }>();
    const closeCandidate = (candidate: GatewayProtocolCandidate): Promise<void> => {
      if (candidate.closeOnce) return candidate.closeOnce;
      candidate.closeOnce = (async () => {
        await candidate.instance.close().catch(() => undefined);
        await candidate.transport.close().catch(() => undefined);
        this.instances.delete(candidate.instance);
      })();
      return candidate.closeOnce;
    };

    const closeEntry = (entry: GatewaySessionEntry): Promise<void> => {
      if (entry.closeOnce) {
        return entry.closeOnce;
      }
      entry.closing = true;
      for (const job of entry.bodyReads) {
        sendJson(job.response, 404, { error: 'Session closed while reading request body' });
        job.controller.abort();
      }
      entry.closeOnce = (async () => {
        await entry.instance.close().catch(() => undefined);
        this.instances.delete(entry.instance);
      })();
      return entry.closeOnce;
    };

    const sweepInterval = Math.min(30_000, Math.max(250, Math.floor(idleTimeoutMs / 3)));
    const sweeper =
      sessionMode === 'stateful'
        ? setInterval(() => {
            const now = Date.now();
            for (const entry of sessionEntries.values()) {
              if (entry.activeRequests > 0) {
                continue;
              }
              if (now - entry.lastActiveAt >= idleTimeoutMs) {
                sessionEntries.delete(entry.sessionId);
                void closeEntry(entry);
              }
            }
          }, sweepInterval)
        : null;
    sweeper?.unref();
    this.httpCleanups.push(() => {
      stopping = true;
      for (const job of bodyReads) {
        sendJson(job.response, 503, { error: 'Gateway is shutting down' });
        job.controller.abort();
      }
      if (sweeper) {
        clearInterval(sweeper);
      }
      const entries = [...sessionEntries.values()];
      sessionEntries.clear();
      const pending = [...pendingCandidates];
      pendingCandidates.clear();
      return Promise.allSettled([
        ...entries.map((entry) => closeEntry(entry)),
        ...pending.map((candidate) => closeCandidate(candidate))
      ]);
    });

    const sendJson = (res: ServerResponse, status: number, payload: unknown): void => {
      // Streaming responses may already have headers on the wire; writing
      // again would throw and kill the process.
      if (res.writableEnded || res.headersSent || res.destroyed) {
        return;
      }
      res.writeHead(status, {
        'content-type': 'application/json',
        ...(status === 413 ? { connection: 'close' } : {})
      });
      res.end(JSON.stringify(payload));
    };

    const readBoundedBody = async (
      req: IncomingMessage,
      response: ServerResponse,
      entry?: GatewaySessionEntry
    ) => {
      const job = { controller: new AbortController(), response };
      bodyReads.add(job);
      if (entry) {
        entry.bodyReads.add(job);
        entry.activeRequests += 1;
        entry.lastActiveAt = Date.now();
      }
      try {
        return await readBoundedHttpBody(req, maxBodyBytes, job.controller.signal);
      } finally {
        bodyReads.delete(job);
        if (entry) {
          entry.bodyReads.delete(job);
          entry.activeRequests -= 1;
          entry.lastActiveAt = Date.now();
        }
      }
    };

    const headerValues = (req: IncomingMessage, name: string): string[] => {
      const values: string[] = [];
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        if (req.rawHeaders[index]?.toLowerCase() === name) {
          const value = req.rawHeaders[index + 1];
          if (typeof value === 'string') {
            values.push(value);
          }
        }
      }
      return values;
    };

    const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (!req.url?.startsWith(path)) {
        sendJson(res, 404, { error: 'Not Found' });
        return;
      }

      if (stopping) {
        sendJson(res, 503, { error: 'Gateway is shutting down' });
        return;
      }

      const sessionHeaderValues = headerValues(req, 'mcp-session-id');
      if (sessionHeaderValues.length > 1) {
        sendJson(res, 400, {
          id: 'unknown',
          error: {
            code: -32602,
            message: 'Duplicate Mcp-Session-Id header',
            traceId: createTraceId()
          }
        });
        return;
      }
      const requestedSessionId = sessionHeaderValues[0];

      if (sessionMode === 'stateless') {
        if (requestedSessionId !== undefined) {
          sendJson(res, 400, {
            id: 'unknown',
            error: {
              code: -32602,
              message: 'Stateless gateway: session id is not accepted',
              traceId: createTraceId()
            }
          });
          return;
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, {
            id: 'unknown',
            error: { code: -32601, message: 'Method not allowed', traceId: createTraceId() }
          });
          return;
        }
        const read = await readBoundedBody(req, res);
        if (stopping) return;
        if (!read.ok) {
          sendJson(res, read.status, { error: read.message });
          return;
        }
        let parsedBody: unknown;
        try {
          parsedBody = read.body.length > 0 ? JSON.parse(read.body.toString('utf8')) : undefined;
        } catch {
          sendJson(res, 400, {
            id: 'unknown',
            error: { code: -32700, message: 'Invalid JSON body', traceId: createTraceId() }
          });
          return;
        }

        if (isJsonObject(parsedBody) && parsedBody.method === 'initialize') {
          const bodyVersion = isJsonObject(parsedBody.params)
            ? parsedBody.params.protocolVersion
            : undefined;
          if (typeof bodyVersion === 'string') {
            const verdict = resolveProtocolVersion(bodyVersion, {
              allowLegacyHttpSse: this.allowLegacyHttpSse
            });
            if (!verdict.ok) {
              sendJson(res, verdict.statusCode, {
                error: { code: -32602, message: verdict.message, traceId: createTraceId() }
              });
              return;
            }
          }
        }
        const headerVerdict = resolveProtocolVersion(headerValues(req, 'mcp-protocol-version')[0], {
          allowLegacyHttpSse: this.allowLegacyHttpSse
        });
        if (!headerVerdict.ok) {
          sendJson(res, headerVerdict.statusCode, {
            error: { code: -32602, message: headerVerdict.message, traceId: createTraceId() }
          });
          return;
        }

        const instance = this.createProtocolInstance();
        // Stateless requests have no session-level negotiation to retain.
        // For a follow-up operation, the transport's accepted wire header
        // (or the protocol-defined absent-header fallback) is its version.
        // Initialize itself is still observed from the actual SDK response.
        if (!isJsonObject(parsedBody) || parsedBody.method !== 'initialize') {
          const protocol = this.protocolVersions.get(instance);
          if (protocol) protocol.version = headerVerdict.version;
        }
        // Per design, sessionIdGenerator must be omitted for stateless mode;
        // the SDK types it as `string | undefined` under exactOptionalPropertyTypes.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined
        } as never);
        const candidate: GatewayProtocolCandidate = { transport, instance, closeOnce: null };
        pendingCandidates.add(candidate);
        let disposed = false;
        const dispose = () => {
          if (disposed) {
            return;
          }
          disposed = true;
          void closeCandidate(candidate).finally(() => pendingCandidates.delete(candidate));
        };
        res.on('close', dispose);
        res.on('finish', dispose);
        try {
          await this.connectProtocolInstance(instance, transport as unknown as Transport);
          if (
            stopping ||
            this.lifecycle === 'closed' ||
            disposed ||
            res.destroyed ||
            res.writableEnded
          ) {
            sendJson(res, 503, { error: 'Gateway is shutting down' });
            dispose();
            await closeCandidate(candidate);
            return;
          }
          await transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          dispose();
          sendJson(res, 500, {
            id: 'unknown',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
              traceId: createTraceId()
            }
          });
        }
        return;
      }

      // ---- stateful ----
      if (requestedSessionId !== undefined) {
        const entry = sessionEntries.get(requestedSessionId);
        if (!entry) {
          sendJson(res, 404, {
            id: 'unknown',
            error: {
              code: -32602,
              message: `Session not found: ${requestedSessionId}`,
              traceId: createTraceId()
            }
          });
          return;
        }
        if (req.method === undefined || !['POST', 'GET', 'DELETE'].includes(req.method)) {
          sendJson(res, 405, {
            id: 'unknown',
            error: { code: -32601, message: 'Method not allowed', traceId: createTraceId() }
          });
          return;
        }
        // An explicit version header must match the version this session
        // negotiated at initialize; absent headers keep the legacy policy.
        const followUpHeader = headerValues(req, 'mcp-protocol-version')[0];
        const negotiatedVersion = this.protocolVersions.get(entry.instance)?.version;
        if (
          followUpHeader !== undefined &&
          negotiatedVersion !== undefined &&
          followUpHeader !== negotiatedVersion
        ) {
          sendJson(res, 400, {
            id: 'unknown',
            error: {
              code: -32602,
              message: `Mcp-Protocol-Version ${followUpHeader} does not match the negotiated ${negotiatedVersion}`,
              traceId: createTraceId()
            }
          });
          return;
        }
        let parsedBody: unknown;
        if (req.method === 'POST') {
          const read = await readBoundedBody(req, res, entry);
          if (stopping) return;
          if (entry.closing || sessionEntries.get(requestedSessionId) !== entry) {
            sendJson(res, 404, { error: 'Session closed while reading request body' });
            return;
          }
          if (!read.ok) {
            sendJson(res, read.status, { error: read.message });
            return;
          }
          try {
            parsedBody = read.body.length > 0 ? JSON.parse(read.body.toString('utf8')) : undefined;
          } catch {
            sendJson(res, 400, {
              id: 'unknown',
              error: { code: -32700, message: 'Invalid JSON body', traceId: createTraceId() }
            });
            return;
          }
        }
        entry.activeRequests += 1;
        entry.lastActiveAt = Date.now();
        try {
          await entry.transport.handleRequest(req, res, parsedBody);
        } catch (error) {
          sendJson(res, 500, {
            id: 'unknown',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
              traceId: createTraceId()
            }
          });
        } finally {
          entry.activeRequests -= 1;
          entry.lastActiveAt = Date.now();
        }
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 400, {
          id: 'unknown',
          error: {
            code: -32000,
            message: `${req.method ?? 'GET'} requires an established session`,
            traceId: createTraceId()
          }
        });
        return;
      }

      const read = await readBoundedBody(req, res);
      if (stopping) return;
      if (!read.ok) {
        sendJson(res, read.status, { error: read.message });
        return;
      }
      let parsedBody: unknown;
      try {
        parsedBody = read.body.length > 0 ? JSON.parse(read.body.toString('utf8')) : {};
      } catch {
        sendJson(res, 400, {
          id: 'unknown',
          error: { code: -32700, message: 'Invalid JSON body', traceId: createTraceId() }
        });
        return;
      }

      if (!isJsonObject(parsedBody) || parsedBody.method !== 'initialize') {
        sendJson(res, 400, {
          id: 'unknown',
          error: {
            code: -32000,
            message: 'initialize request required to establish a session',
            traceId: createTraceId()
          }
        });
        return;
      }

      // Version policy covers BOTH the initialize body and follow-up headers.
      const bodyVersion = isJsonObject(parsedBody.params)
        ? parsedBody.params.protocolVersion
        : undefined;
      if (typeof bodyVersion === 'string') {
        const bodyCheck = resolveProtocolVersion(bodyVersion, {
          allowLegacyHttpSse: this.allowLegacyHttpSse
        });
        if (!bodyCheck.ok) {
          sendJson(res, bodyCheck.statusCode, {
            id: 'unknown',
            error: { code: -32602, message: bodyCheck.message, traceId: createTraceId() }
          });
          return;
        }
      }
      const protocolHeader = headerValues(req, 'mcp-protocol-version')[0];
      const checkedProtocol = resolveProtocolVersion(protocolHeader, {
        allowLegacyHttpSse: this.allowLegacyHttpSse
      });
      if (!checkedProtocol.ok) {
        sendJson(res, checkedProtocol.statusCode, {
          id: 'unknown',
          error: { code: -32602, message: checkedProtocol.message, traceId: createTraceId() }
        });
        return;
      }

      if (sessionEntries.size + pendingCandidates.size >= maxSessions) {
        sendJson(res, 503, {
          id: 'unknown',
          error: {
            code: -32000,
            message: `Too many sessions (max ${maxSessions})`,
            traceId: createTraceId()
          }
        });
        return;
      }

      const instance = this.createProtocolInstance();
      let initializedEntry: GatewaySessionEntry | null = null;
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => createTraceId(),
        onsessioninitialized: (sessionId) => {
          if (stopping || this.lifecycle === 'closed' || candidate.closeOnce || res.destroyed)
            throw new Error('Gateway is shutting down');
          initializedEntry = {
            sessionId,
            transport,
            instance,
            lastActiveAt: Date.now(),
            activeRequests: 0,
            closeOnce: null,
            closing: false,
            bodyReads: new Set()
          };
          pendingCandidates.delete(candidate);
          sessionEntries.set(sessionId, initializedEntry);
        },
        onsessionclosed: (sessionId) => {
          const entry = sessionEntries.get(sessionId);
          sessionEntries.delete(sessionId);
          if (entry) {
            void closeEntry(entry);
          }
        }
      });
      const candidate: GatewayProtocolCandidate = { transport, instance, closeOnce: null };
      pendingCandidates.add(candidate);

      try {
        await this.connectProtocolInstance(instance, transport as unknown as Transport);
        if (
          stopping ||
          this.lifecycle === 'closed' ||
          candidate.closeOnce ||
          res.destroyed ||
          res.writableEnded
        ) {
          sendJson(res, 503, { error: 'Gateway is shutting down' });
          return;
        }
        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        process.stderr.write(
          `[gateway-http] handleRequest error: ${
            error instanceof Error ? (error.stack ?? error.message) : String(error)
          }\n`
        );
        sendJson(res, 500, {
          id: 'unknown',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
            traceId: createTraceId()
          }
        });
      } finally {
        if (!initializedEntry) {
          pendingCandidates.delete(candidate);
          await closeCandidate(candidate);
        }
      }
    });

    trackHttpListener(server);
    server.listen(options.port);
    this.httpListeners.push(server);
    return server;
  }

  /** Idempotent close of all protocol instances and downstream connectors. */
  public async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = (async () => {
      this.lifecycle = 'closed';
      this.shutdownController.abort(new DOMException('Gateway shutting down', 'AbortError'));
      const listeners = this.httpListeners.splice(0);
      const closingListeners = listeners.map((listener) =>
        closeHttpListener(listener, this.shutdownGraceMs)
      );
      const cleanups = this.httpCleanups.splice(0);
      await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
      // Instances before listeners: closing instances ends live response
      // streams so listener.close() can complete.
      const instances = Array.from(this.instances);
      this.instances.clear();
      await Promise.allSettled(instances.map((instance) => instance.close()));
      listeners.forEach((listener) => listener.closeIdleConnections());
      await Promise.allSettled(closingListeners);
      await Promise.allSettled([...this.invocations]);
      await this.gatewayCore.close();
      await this.auditStore.close?.();
    })();
    return this.closePromise;
  }

  /** Protocol instances currently owned (sessions, requests, stdio). */
  public get activeProtocolInstanceCount(): number {
    return this.instances.size;
  }

  public getInMemoryAuditEvents(): AuditEvent[] {
    if (this.auditStore instanceof InMemoryAuditStore) {
      return this.auditStore.list();
    }
    return [];
  }

  private createProtocolInstance(): SdkServer {
    if (this.lifecycle === 'closed') throw new Error('Gateway is closed');
    const instance = new SdkServer(this.serverInfo, {
      capabilities: { tools: {} }
    });
    const protocol: { version?: string } = {};
    this.protocolVersions.set(instance, protocol);

    instance.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.advertisedTools()
    }));

    instance.setRequestHandler(CallToolRequestSchema, (request, extra) => {
      const call = this.handleToolCall(request, extra, protocol.version);
      this.invocations.add(call);
      void call.finally(() => this.invocations.delete(call)).catch(() => undefined);
      return call;
    });

    instance.onclose = () => this.instances.delete(instance);
    this.instances.add(instance);
    return instance;
  }

  private async connectProtocolInstance(instance: SdkServer, transport: Transport): Promise<void> {
    const initializeIds = new Set<string | number>();
    const send = transport.send.bind(transport);
    // Capture the SDK's initialize RESPONSE instead of copying the request.
    // Negotiation may choose a different version when a peer asks for one
    // outside the SDK supported set (notably stdio compatibility paths).
    const observeSend: Transport['send'] = async (message, options) => {
      if ('result' in message && initializeIds.delete(message.id)) {
        const protocol = this.protocolVersions.get(instance);
        if (protocol && typeof message.result.protocolVersion === 'string')
          protocol.version = message.result.protocolVersion;
      }
      await send(message, options);
    };
    // Install incoming observation before connect starts the transport: a
    // stdio peer can already have initialize buffered when start() runs.
    // Forward property access and bind methods to the original owner, so
    // SDK transports' private state and callbacks keep their normal owner.
    const observed = new Proxy(transport, {
      get(target, property) {
        if (property === 'send') return observeSend;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value: unknown) {
        if (property === 'onmessage' && typeof value === 'function') {
          const callback = value as NonNullable<Transport['onmessage']>;
          const receive: NonNullable<Transport['onmessage']> = (message, extra) => {
            if ('method' in message && message.method === 'initialize' && 'id' in message)
              initializeIds.add(message.id);
            callback(message, extra);
          };
          return Reflect.set(target, property, receive, target);
        }
        return Reflect.set(target, property, value, target);
      }
    });
    await instance.connect(observed);
  }

  private advertisedTools(): Tool[] {
    const catalog = this.gatewayCore.getCatalog();
    if (!catalog) {
      return [];
    }
    const visible = new Set(
      this.policyEngine.filterVisibleTools(catalog.entries.map((entry) => entry.publicName))
    );
    const tools: Tool[] = [];
    for (const entry of catalog.entries) {
      if (!visible.has(entry.publicName)) {
        continue;
      }
      const capability = this.capabilityRegistry.resolve({
        publicName: entry.publicName,
        backendId: entry.backendId,
        backendToolName: entry.backendToolName,
        description: entry.advertised.description ?? '',
        ...(entry.metadata ? { metadata: entry.metadata } : {})
      });
      if (capability.visibility === 'hidden') {
        continue;
      }
      const description = this.capabilityRegistry.toDescription(
        entry.advertised.description ?? '',
        capability
      );
      tools.push(
        ToolSchema.parse({
          name: entry.publicName,
          ...(entry.advertised.title ? { title: entry.advertised.title } : {}),
          ...(entry.advertised.icons ? { icons: entry.advertised.icons } : {}),
          ...(description !== '' ? { description } : {}),
          inputSchema: entry.advertised.inputSchema,
          ...(entry.advertised.outputSchema !== undefined
            ? { outputSchema: entry.advertised.outputSchema }
            : {}),
          ...(entry.advertised.annotations !== undefined
            ? { annotations: entry.advertised.annotations }
            : {}),
          ...(entry.advertised.execution !== undefined
            ? { execution: entry.advertised.execution }
            : {}),
          _meta: {
            ...(entry.advertised._meta ?? {}),
            'org.ai-mcp/downstream-tool': {
              ...(isJsonObject(entry.advertised._meta?.['org.ai-mcp/downstream-tool'])
                ? entry.advertised._meta['org.ai-mcp/downstream-tool']
                : {}),
              backendId: entry.backendId,
              toolName: entry.backendToolName,
              snapshotRevision: entry.snapshotRevision
            }
          }
        })
      );
    }
    return tools;
  }

  private async handleToolCall(
    request: z.infer<typeof CallToolRequestSchema>,
    extra: { signal: AbortSignal; sessionId?: string; requestId: string | number },
    protocolVersion?: string
  ): Promise<CallToolResult> {
    const publicName = request.params?.name ?? '';
    const entry = this.gatewayCore.getCatalog()?.findByPublicName(publicName);
    if (!entry) {
      throw new SdkMcpError(-32602, `Unknown tool: ${publicName}`, {
        category: 'invalid_request',
        traceId: createTraceId()
      });
    }

    const context = this.buildInvocationContext(request.params?._meta, extra, protocolVersion);
    const startedAt = Date.now();
    const input = request.params?.arguments ?? {};
    const inputHash =
      this.auditHashSecret !== null ? hashInputPayload(input, this.auditHashSecret) : undefined;
    const capability = this.capabilityRegistry.resolve({
      publicName: entry.publicName,
      backendId: entry.backendId,
      backendToolName: entry.backendToolName,
      description: entry.advertised.description ?? '',
      ...(entry.metadata ? { metadata: entry.metadata } : {})
    });

    // Listing hides invisible tools, but calls must be re-checked: hiding
    // from tools/list alone is not an authorization decision.
    if (capability.visibility === 'hidden') {
      await this.recordAuditSafely(
        {
          context,
          extra,
          entry,
          decision: 'deny',
          outcome: 'protocol_error',
          resultCode: 'policy_denied',
          executionDisposition: 'not_started',
          durationMs: Date.now() - startedAt,
          reason: `tool not visible: ${entry.publicName}`,
          policyReasonCode: 'ALLOWLIST'
        },
        false
      );
      throw new SdkMcpError(POLICY_DENIED_ERROR_CODE, `tool not visible: ${entry.publicName}`, {
        category: 'policy_denied',
        traceId: context.traceId,
        invocationId: context.invocationId
      });
    }

    const decision = this.policyEngine.authorizeCall({
      tenantId: this.tenantId,
      toolName: entry.publicName,
      traceId: context.traceId,
      now: Date.now(),
      riskLevel: capability.riskLevel,
      tags: capability.tags,
      requiredPermissions: capability.requiredPermissions
    });

    if (!decision.allowed) {
      const code =
        decision.reasonCode === 'RATE_LIMIT' ? RATE_LIMITED_ERROR_CODE : POLICY_DENIED_ERROR_CODE;
      const category = decision.reasonCode === 'RATE_LIMIT' ? 'rate_limited' : 'policy_denied';
      await this.recordAuditSafely(
        {
          context,
          extra,
          entry,
          decision: 'deny',
          outcome: 'protocol_error',
          resultCode: category,
          executionDisposition: 'not_started',
          durationMs: Date.now() - startedAt,
          ...(inputHash ? { inputHash } : {}),
          ...(decision.reasonCode ? { policyReasonCode: decision.reasonCode } : {}),
          ...(decision.reason ? { reason: decision.reason } : {})
        },
        false
      );
      throw new SdkMcpError(code, decision.reason ?? 'policy denied', {
        category,
        traceId: context.traceId,
        invocationId: context.invocationId
      });
    }

    const inputCheck = entry.inputValidator.validate(input);
    if (!inputCheck.valid) {
      const message = `Invalid input for tool ${entry.publicName}: ${inputCheck.issues
        .map((issue) => `${issue.path || '(root)'} ${issue.message}`)
        .join('; ')}`;
      await this.recordAuditSafely(
        {
          context,
          extra,
          entry,
          decision: 'allow',
          outcome: 'protocol_error',
          resultCode: 'invalid_params',
          executionDisposition: 'not_started',
          durationMs: Date.now() - startedAt,
          ...(inputHash ? { inputHash } : {}),
          reason: message
        },
        false
      );
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              code: 'INVALID_PARAMS',
              message,
              traceId: context.traceId
            })
          }
        ],
        structuredContent: {
          code: 'INVALID_PARAMS',
          message,
          traceId: context.traceId
        },
        isError: true
      };
    }

    let callResult;
    try {
      callResult = await awaitWithSignal(
        this.gatewayCore.callMappedTool(entry.publicName, input, context.signal, {
          traceId: context.traceId,
          ...(context.runId !== undefined ? { runId: context.runId } : {}),
          ...(context.taskId !== undefined ? { taskId: context.taskId } : {})
        }),
        context.signal
      );
    } catch (error) {
      const fault = this.toFault(error, entry, context);
      await this.recordAuditSafely(
        {
          context,
          extra,
          entry,
          decision: 'allow',
          outcome: fault.category === 'cancelled' ? 'cancelled' : 'protocol_error',
          resultCode: fault.projectCode,
          executionDisposition: fault.executionDisposition,
          durationMs: Date.now() - startedAt,
          ...(inputHash ? { inputHash } : {}),
          reason: fault.message,
          ...(fault.source?.traceId ? { downstreamTraceId: fault.source.traceId } : {}),
          ...(fault.category ? { errorCategory: fault.category } : {})
        },
        fault.executionDisposition === 'completed'
          ? true
          : fault.executionDisposition === 'not_started'
            ? false
            : null
      );
      const numeric = LEGACY_ERROR_CODE_BY_CATEGORY[fault.category] ?? -32603;
      throw new SdkMcpError(numeric, fault.message, {
        category: fault.category,
        projectCode: fault.projectCode,
        traceId: fault.traceId,
        invocationId: fault.invocationId,
        executionDisposition: fault.executionDisposition,
        message: fault.message,
        ...(fault.source ? { source: fault.source } : {}),
        ...(fault.details ? { details: fault.details } : {}),
        ...(fault.operationCompleted !== undefined
          ? { operationCompleted: fault.operationCompleted }
          : {})
      });
    }

    const adapted = adaptDownstreamResult(callResult.native, callResult.entry, {
      traceId: context.traceId,
      invocationId: context.invocationId,
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
      ...(context.taskId !== undefined ? { taskId: context.taskId } : {})
    });
    const standard = 'standard' in adapted ? adapted.standard : undefined;

    if (adapted.kind === 'failure') {
      const fault = adapted.fault;
      await this.recordAuditSafely(
        {
          context,
          extra,
          entry,
          decision: 'allow',
          outcome: 'protocol_error',
          resultCode: fault.projectCode,
          executionDisposition: fault.executionDisposition,
          durationMs: callResult.durationMs,
          ...(inputHash ? { inputHash } : {}),
          reason: fault.message,
          errorCategory: fault.category
        },
        true
      );
      throw new SdkMcpError(-32603, fault.message, {
        category: fault.category,
        projectCode: fault.projectCode,
        traceId: fault.traceId,
        invocationId: fault.invocationId,
        executionDisposition: fault.executionDisposition
      });
    }

    const outcome: AuditOutcome = adapted.kind === 'tool_failure' ? 'tool_error' : 'success';
    const downstreamTrace =
      callResult.native._meta !== undefined &&
      isJsonObject(callResult.native._meta) &&
      isJsonObject(callResult.native._meta['org.ai-mcp/context'])
        ? typeof callResult.native._meta['org.ai-mcp/context'].traceId === 'string'
          ? (callResult.native._meta['org.ai-mcp/context'].traceId as string)
          : undefined
        : undefined;

    await this.recordAuditSafely(
      {
        context,
        extra,
        entry,
        decision: 'allow',
        outcome,
        ...(adapted.kind === 'tool_failure'
          ? { resultCode: 'TOOL_FAILED' }
          : standard?.ok
            ? { resultCode: 'OK' }
            : {}),
        durationMs: callResult.durationMs,
        ...(inputHash ? { inputHash } : {}),
        ...(standard ? { outputSummary: this.summarize(standard) } : {}),
        ...(downstreamTrace ? { downstreamTraceId: downstreamTrace } : {})
      },
      true
    );

    const serialized = JSON.stringify(standard ?? {});
    return {
      content: [
        { type: 'text', text: serialized },
        ...CallToolResultSchema.parse({ content: callResult.native.content }).content
      ],
      _meta: {
        ...(callResult.native._meta ?? {}),
        [CONTEXT_META_KEY]: {
          traceId: context.traceId,
          ...(context.runId ? { runId: context.runId } : {}),
          ...(context.taskId ? { taskId: context.taskId } : {})
        }
      },
      ...(standard !== undefined ? { structuredContent: standard as Record<string, unknown> } : {}),
      isError: adapted.kind === 'tool_failure'
    };
  }

  private buildInvocationContext(
    requestMeta: unknown,
    extra: { signal: AbortSignal; sessionId?: string; requestId: string | number },
    protocolVersion?: string
  ): InvocationContext {
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

    return {
      invocationId: createInvocationId(),
      traceId: traceId ?? createTraceId(),
      requestId: extra.requestId,
      peerEra: 'legacy',
      protocolVersion: protocolVersion ?? 'unknown',
      ...(extra.sessionId !== undefined ? { mcpSessionId: extra.sessionId } : {}),
      ...{
        ...(runId !== undefined ? { runId } : this.runId !== undefined ? { runId: this.runId } : {})
      },
      ...(taskId !== undefined ? { taskId } : {}),
      deadlineAt: Number.MAX_SAFE_INTEGER,
      signal: AbortSignal.any([extra.signal, this.shutdownController.signal]),
      actor: { tenantId: this.tenantId, ...(this.who ? { who: this.who } : {}) }
    };
  }

  private toFault(
    error: unknown,
    entry: CatalogEntry,
    context: InvocationContext
  ): {
    category: string;
    projectCode: string;
    message: string;
    traceId: string;
    invocationId: string;
    executionDisposition: 'not_started' | 'completed' | 'unknown';
    source?: FaultSource;
    details?: JsonObject;
    operationCompleted?: boolean | null;
  } {
    if (context.signal.aborted)
      return {
        category: 'cancelled',
        projectCode: 'CANCELLED',
        message: 'Tool call cancelled',
        traceId: context.traceId,
        invocationId: context.invocationId,
        executionDisposition: 'unknown'
      };
    if (error instanceof DownstreamConnectorError) {
      const peerFault = connectorInvocationFault(error.details);
      if (peerFault) {
        return {
          category: peerFault.category,
          projectCode: peerFault.projectCode,
          message: peerFault.message,
          traceId: context.traceId,
          invocationId: context.invocationId,
          executionDisposition: peerFault.executionDisposition,
          source: {
            ...(peerFault.source ?? { kind: 'peer', backendId: entry.backendId }),
            traceId: peerFault.source?.traceId ?? peerFault.traceId
          },
          // Keep the immediate peer identity and its original source/details
          // together while the outer fault keeps this invocation's identity.
          details: { ...(peerFault.details ?? {}), peerFault: peerFault as unknown as JsonObject },
          ...(peerFault.operationCompleted !== undefined
            ? { operationCompleted: peerFault.operationCompleted }
            : {})
        };
      }
      const category = error.category;
      const projectCode =
        category === 'backend_timeout'
          ? 'BACKEND_TIMEOUT'
          : category === 'backend_unavailable'
            ? 'BACKEND_UNAVAILABLE'
            : category === 'invalid_result'
              ? 'INVALID_RESULT'
              : category === 'cancelled'
                ? 'CANCELLED'
                : category === 'invalid_request'
                  ? 'INVALID_PARAMS'
                  : 'INTERNAL';
      return {
        category,
        projectCode,
        message: error.message,
        traceId: context.traceId,
        invocationId: context.invocationId,
        executionDisposition: 'unknown'
      };
    }
    return {
      category: 'internal',
      projectCode: 'INTERNAL',
      message: error instanceof Error ? error.message : String(error),
      traceId: context.traceId,
      invocationId: context.invocationId,
      executionDisposition: 'unknown'
    };
  }

  /**
   * Records one audit event. A persistence failure never re-executes the
   * tool: it surfaces as audit_unavailable with operationCompleted marking
   * whether the business operation already ran.
   */
  private async recordAuditSafely(
    fields: Parameters<McpGatewayServer['recordAudit']>[0],
    operationCompleted: boolean | null
  ): Promise<void> {
    try {
      await this.recordAudit(fields);
    } catch (error) {
      const message = `Audit persistence failed: ${error instanceof Error ? error.message : String(error)}`;
      throw new SdkMcpError(-32603, message, {
        category: 'audit_unavailable',
        projectCode: 'AUDIT_UNAVAILABLE',
        traceId: fields.context.traceId,
        invocationId: fields.context.invocationId,
        message,
        executionDisposition:
          operationCompleted === true
            ? 'completed'
            : operationCompleted === false
              ? 'not_started'
              : 'unknown',
        source: { kind: 'audit', traceId: fields.context.traceId },
        operationCompleted
      });
    }
  }

  private async recordAudit(fields: {
    context: InvocationContext;
    extra: { sessionId?: string; requestId: string | number };
    entry: CatalogEntry;
    decision: 'allow' | 'deny';
    outcome: AuditOutcome;
    resultCode?: string;
    executionDisposition?: 'not_started' | 'completed' | 'unknown';
    durationMs?: number;
    inputHash?: string;
    outputSummary?: string;
    policyReasonCode?: 'RATE_LIMIT' | 'ALLOWLIST' | 'RISK_LEVEL' | 'CONDITIONAL_ALLOW';
    downstreamTraceId?: string;
    errorCategory?: string;
    reason?: string;
  }): Promise<void> {
    const event: AuditEvent = {
      timestamp: new Date().toISOString(),
      tenantId: this.tenantId,
      action: 'tools/call',
      toolName: fields.entry.publicName,
      traceId: fields.context.traceId,
      decision: fields.decision,
      outcome: fields.outcome,
      ...(fields.resultCode !== undefined ? { resultCode: fields.resultCode } : {}),

      ...(fields.executionDisposition !== undefined
        ? { executionDisposition: fields.executionDisposition }
        : {}),
      invocationId: fields.context.invocationId,
      requestId: fields.extra.requestId,
      ...(fields.extra.sessionId !== undefined ? { mcpSessionId: fields.extra.sessionId } : {}),
      protocolVersion: fields.context.protocolVersion,
      ...(this.who ? { who: this.who } : {}),
      ...(this.agent ? { agent: this.agent } : {}),
      ...(fields.context.runId !== undefined ? { runId: fields.context.runId } : {}),
      ...(fields.context.taskId !== undefined ? { taskId: fields.context.taskId } : {}),
      downstream: {
        backendId: fields.entry.backendId,
        backendToolName: fields.entry.backendToolName
      },
      ...(fields.durationMs !== undefined ? { durationMs: fields.durationMs } : {}),
      ...(fields.outputSummary !== undefined ? { outputSummary: fields.outputSummary } : {}),
      capabilityRiskLevel: this.capabilityRegistry.resolve({
        publicName: fields.entry.publicName,
        backendId: fields.entry.backendId,
        backendToolName: fields.entry.backendToolName,
        description: '',
        ...(fields.entry.metadata ? { metadata: fields.entry.metadata } : {})
      }).riskLevel,
      ...(fields.policyReasonCode ? { policyReasonCode: fields.policyReasonCode } : {}),
      ...(fields.inputHash ? { inputHash: fields.inputHash } : {}),
      ...(fields.downstreamTraceId ? { downstreamTraceId: fields.downstreamTraceId } : {}),
      ...(fields.errorCategory ? { errorCategory: fields.errorCategory } : {}),
      ...(fields.reason ? { reason: fields.reason } : {})
    };
    await this.auditStore.record(event);
  }

  private summarize(output: StandardToolResult): string {
    const summary = [output.code, output.message].filter((item) => item.length > 0).join(': ');
    if (summary.length > 0) {
      return summary.slice(0, 200);
    }
    if (output.structuredContent !== undefined) {
      return JSON.stringify(output.structuredContent).slice(0, 200);
    }
    return output.ok ? 'ok' : 'failed';
  }
}

export type { JsonObject };
