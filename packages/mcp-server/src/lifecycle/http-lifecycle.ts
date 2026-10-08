import { isJsonObject, readBoundedHttpBody } from '@ai-mcp/shared';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { McpServer as SdkMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export type SessionMode = 'stateful' | 'stateless';

export const DEFAULT_SESSION_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
export const DEFAULT_MAX_SESSIONS = 256;
export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const DEFAULT_SHUTDOWN_GRACE_MS = 5000;

type SessionState = 'active' | 'closing' | 'closed';
type BodyReadJob = { controller: AbortController; response: ServerResponse };
type ProtocolCandidate = {
  transport: StreamableHTTPServerTransport;
  instance: SdkMcpServer;
  closeOnce: Promise<void> | null;
};

type SessionEntry = {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  instance: SdkMcpServer;
  lastActiveAt: number;
  activeRequests: number;
  state: SessionState;
  closeOnce: Promise<void> | null;
  bodyReads: Set<BodyReadJob>;
};

export type HttpLifecycleOptions = {
  createInstance: () => SdkMcpServer;
  sessionMode: SessionMode;
  sessionIdleTimeoutMs?: number;
  maxSessions?: number;
  maxBodySizeBytes?: number;
  /** Optional policy hook over the initialize body protocol version. */
  validateInitializeVersion?: (version: unknown) => { ok: true } | { ok: false; message: string };
  /** Notified when a lifecycle-owned instance is fully disposed. */
  onInstanceClosed?: (instance: SdkMcpServer) => void;
};

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.writableEnded || res.headersSent || res.destroyed) {
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(status === 413 ? { connection: 'close' } : {})
  });
  res.end(JSON.stringify(payload));
}

function headerValues(req: IncomingMessage, name: string): string[] {
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
}

/**
 * Owns every SDK protocol instance created for the /mcp HTTP endpoint.
 * Stateful: one server/transport pair per session with pending-init
 * tracking, TTL and bounded session count. Stateless: one pair per request,
 * disposed exactly when its response stream really finishes. Closing client
 * A only ever releases A's resources.
 */
export class McpHttpLifecycle {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly pending = new Set<ProtocolCandidate>();
  private readonly idleTimeoutMs: number;
  private readonly maxSessions: number;
  private readonly maxBodyBytes: number;
  private sweeper: NodeJS.Timeout | null = null;
  private stopping = false;
  private closePromise: Promise<void> | null = null;
  private readonly bodyReads = new Set<BodyReadJob>();

  public constructor(private readonly options: HttpLifecycleOptions) {
    this.idleTimeoutMs = options.sessionIdleTimeoutMs ?? DEFAULT_SESSION_IDLE_TIMEOUT_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.maxBodyBytes = options.maxBodySizeBytes ?? DEFAULT_MAX_BODY_BYTES;
    if (options.sessionMode === 'stateful') {
      // Sweeper keeps timers unref'd so it never holds the process open;
      // small TTLs get a proportionally faster sweep for tests.
      const interval = Math.min(30_000, Math.max(250, Math.floor(this.idleTimeoutMs / 3)));
      this.sweeper = setInterval(() => this.sweepIdleSessions(), interval);
      this.sweeper.unref();
    }
  }

  public get sessionCount(): number {
    return this.sessions.size;
  }

  public async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.stopping) {
      sendJson(res, 503, { error: 'Server is shutting down' });
      return;
    }

    const sessionHeader = headerValues(req, 'mcp-session-id');
    if (sessionHeader.length > 1) {
      sendJson(res, 400, {
        id: 'unknown',
        error: { code: -32602, message: 'Duplicate Mcp-Session-Id header', traceId: randomUUID() }
      });
      return;
    }
    const sessionId = sessionHeader[0];

    if (this.options.sessionMode === 'stateless') {
      await this.handleStateless(req, res, sessionId);
      return;
    }
    await this.handleStateful(req, res, sessionId);
  }

  public close(graceMs = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = (async () => {
      this.stopping = true;
      for (const job of this.bodyReads) {
        sendJson(job.response, 503, { error: 'Server is shutting down' });
        job.controller.abort();
      }
      if (this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
      // Close every entry (sessions + pending) even if some fail.
      const entries = [...this.sessions.values()];
      this.sessions.clear();
      const pending = [...this.pending];
      this.pending.clear();
      await Promise.allSettled([
        ...entries.map((entry) => this.closeEntry(entry)),
        ...pending.map((candidate) => this.closeCandidate(candidate))
      ]);
      // Give in-flight responses a bounded drain window.
      const deadline = Date.now() + Math.max(0, graceMs);
      while (Date.now() < deadline && this.hasActiveRequests(entries)) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    })();
    return this.closePromise;
  }

  private hasActiveRequests(entries: SessionEntry[]): boolean {
    return entries.some((entry) => entry.activeRequests > 0);
  }

  private closeCandidate(candidate: ProtocolCandidate): Promise<void> {
    if (candidate.closeOnce) return candidate.closeOnce;
    candidate.closeOnce = (async () => {
      await candidate.instance.close().catch(() => undefined);
      // connect/start may still be pending while the SDK detaches its
      // transport. The candidate retains ownership of that transport.
      await candidate.transport.close().catch(() => undefined);
      this.options.onInstanceClosed?.(candidate.instance);
    })();
    return candidate.closeOnce;
  }

  private async readBody(req: IncomingMessage, response: ServerResponse, entry?: SessionEntry) {
    const job: BodyReadJob = { controller: new AbortController(), response };
    this.bodyReads.add(job);
    if (entry) {
      entry.bodyReads.add(job);
      entry.activeRequests += 1;
      entry.lastActiveAt = Date.now();
    }
    try {
      return await readBoundedHttpBody(req, this.maxBodyBytes, job.controller.signal);
    } finally {
      this.bodyReads.delete(job);
      if (entry) {
        entry.bodyReads.delete(job);
        entry.activeRequests -= 1;
        entry.lastActiveAt = Date.now();
      }
    }
  }

  private async handleStateless(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined
  ): Promise<void> {
    if (sessionId !== undefined) {
      sendJson(res, 400, {
        id: 'unknown',
        error: {
          code: -32602,
          message: 'Stateless server: session id is not accepted',
          traceId: randomUUID()
        }
      });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, {
        id: 'unknown',
        error: { code: -32601, message: 'Method not allowed', traceId: randomUUID() }
      });
      return;
    }

    const read = await this.readBody(req, res);
    if (this.stopping) return;
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
        error: { code: -32700, message: 'Invalid JSON body', traceId: randomUUID() }
      });
      return;
    }

    if (
      isJsonObject(parsedBody) &&
      parsedBody.method === 'initialize' &&
      this.options.validateInitializeVersion
    ) {
      const verdict = this.options.validateInitializeVersion(
        isJsonObject(parsedBody.params) ? parsedBody.params.protocolVersion : undefined
      );
      if (!verdict.ok) {
        sendJson(res, 400, {
          error: { code: -32602, message: verdict.message, traceId: randomUUID() }
        });
        return;
      }
    }

    const instance = this.options.createInstance();
    // SDK option typing marks sessionIdGenerator as `string | undefined` under
    // exactOptionalPropertyTypes; passing the property explicitly is the
    // documented stateless configuration.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    } as never);
    const candidate: ProtocolCandidate = { transport, instance, closeOnce: null };
    this.pending.add(candidate);
    // Dispose exactly once, when the response stream truly ends; closing
    // earlier would cut handlers the SDK has not finished writing.
    let disposed = false;
    const dispose = () => {
      if (disposed) {
        return;
      }
      disposed = true;
      void this.closeCandidate(candidate).finally(() => {
        this.pending.delete(candidate);
      });
    };
    res.on('close', () => {
      dispose();
    });
    res.on('finish', () => {
      dispose();
    });

    try {
      await instance.connect(transport as unknown as Transport);
      if (this.stopping || disposed || res.destroyed || res.writableEnded) {
        sendJson(res, 503, { error: 'Server is shutting down' });
        dispose();
        await this.closeCandidate(candidate);
        return;
      }
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      dispose();
      if (!res.headersSent) {
        sendJson(res, 500, {
          id: 'unknown',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
            traceId: randomUUID()
          }
        });
      }
    }
  }

  private async handleStateful(
    req: IncomingMessage,
    res: ServerResponse,
    sessionId: string | undefined
  ): Promise<void> {
    if (sessionId !== undefined) {
      const entry = this.sessions.get(sessionId);
      if (!entry) {
        sendJson(res, 404, {
          id: 'unknown',
          error: {
            code: -32602,
            message: `Session not found: ${sessionId}`,
            traceId: randomUUID()
          }
        });
        return;
      }
      if (req.method === undefined || !['POST', 'GET', 'DELETE'].includes(req.method)) {
        sendJson(res, 405, {
          id: 'unknown',
          error: { code: -32601, message: 'Method not allowed', traceId: randomUUID() }
        });
        return;
      }

      let parsedBody: unknown;
      if (req.method === 'POST') {
        const read = await this.readBody(req, res, entry);
        if (this.stopping) return;
        if (entry.state !== 'active' || this.sessions.get(sessionId) !== entry) {
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
            error: { code: -32700, message: 'Invalid JSON body', traceId: randomUUID() }
          });
          return;
        }
      }

      // A response finishing (or a GET stream closing) never closes the
      // session; only DELETE, transport close or server close does.
      entry.activeRequests += 1;
      entry.lastActiveAt = Date.now();
      try {
        await entry.transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            id: 'unknown',
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
              traceId: randomUUID()
            }
          });
        }
      } finally {
        entry.activeRequests -= 1;
        entry.lastActiveAt = Date.now();
      }
      return;
    }

    // No session header from here on.
    if (req.method !== 'POST') {
      sendJson(res, 400, {
        id: 'unknown',
        error: {
          code: -32000,
          message: `${req.method ?? 'GET'} requires an established session`,
          traceId: randomUUID()
        }
      });
      return;
    }

    const read = await this.readBody(req, res);
    if (this.stopping) return;
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
        error: { code: -32700, message: 'Invalid JSON body', traceId: randomUUID() }
      });
      return;
    }

    if (!isJsonObject(parsedBody) || parsedBody.method !== 'initialize') {
      sendJson(res, 400, {
        id: 'unknown',
        error: {
          code: -32000,
          message: 'initialize request required to establish a session',
          traceId: randomUUID()
        }
      });
      return;
    }

    if (this.options.validateInitializeVersion) {
      const verdict = this.options.validateInitializeVersion(
        isJsonObject(parsedBody.params) ? parsedBody.params.protocolVersion : undefined
      );
      if (!verdict.ok) {
        sendJson(res, 400, {
          id: 'unknown',
          error: { code: -32602, message: verdict.message, traceId: randomUUID() }
        });
        return;
      }
    }

    if (this.sessions.size + this.pending.size >= this.maxSessions) {
      sendJson(res, 503, {
        id: 'unknown',
        error: {
          code: -32000,
          message: `Too many sessions (max ${this.maxSessions})`,
          traceId: randomUUID()
        }
      });
      return;
    }

    const instance = this.options.createInstance();
    let entry: SessionEntry | null = null;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (initialized) => {
        // A close can also win after connect but before the transport's
        // asynchronous initialization callback. Abort registration and the
        // remaining SDK request path rather than recreating a closed entry.
        if (this.stopping || candidate.closeOnce || res.destroyed)
          throw new Error('Server is shutting down');
        entry = {
          sessionId: initialized,
          transport,
          instance,
          lastActiveAt: Date.now(),
          activeRequests: 0,
          state: 'active',
          closeOnce: null,
          bodyReads: new Set()
        };
        this.pending.delete(candidate);
        this.sessions.set(initialized, entry);
      },
      onsessionclosed: (closed) => {
        this.sessions.delete(closed);
        if (entry && entry.sessionId === closed) {
          void this.closeEntry(entry);
        }
      }
    });
    const candidate: ProtocolCandidate = { transport, instance, closeOnce: null };
    this.pending.add(candidate);

    try {
      await instance.connect(transport as unknown as Transport);
      if (this.stopping || candidate.closeOnce || res.destroyed || res.writableEnded) {
        sendJson(res, 503, { error: 'Server is shutting down' });
        return;
      }
      await transport.handleRequest(req, res, parsedBody);
    } catch (error) {
      if (!res.headersSent) {
        sendJson(res, 500, {
          id: 'unknown',
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
            traceId: randomUUID()
          }
        });
      }
    } finally {
      // Initialization never completed: release the candidate pair.
      if (!entry) {
        this.pending.delete(candidate);
        await this.closeCandidate(candidate);
      }
    }
  }

  private closeEntry(entry: SessionEntry): Promise<void> {
    if (entry.closeOnce) {
      return entry.closeOnce;
    }
    entry.state = 'closing';
    for (const job of entry.bodyReads) {
      sendJson(job.response, 404, { error: 'Session closed while reading request body' });
      job.controller.abort();
    }
    entry.closeOnce = (async () => {
      await entry.instance.close().catch(() => undefined);
      entry.state = 'closed';
      this.options.onInstanceClosed?.(entry.instance);
    })();
    return entry.closeOnce;
  }

  private sweepIdleSessions(): void {
    const now = Date.now();
    for (const entry of this.sessions.values()) {
      if (entry.activeRequests > 0) {
        continue;
      }
      if (now - entry.lastActiveAt >= this.idleTimeoutMs) {
        this.sessions.delete(entry.sessionId);
        void this.closeEntry(entry);
      }
    }
  }
}
