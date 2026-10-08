import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  awaitWithSignal,
  isJsonObject,
  type JsonObject,
  type ResultContract,
  type ToolDescriptor
} from '@ai-mcp/shared';
import { McpClient, McpClientError, pinProtocolVersion } from '@ai-mcp/mcp-client';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  BackendTool,
  CallContextOptions,
  DownstreamConnector,
  DownstreamToolCallResult
} from './base.js';
import { DownstreamConnectorError, withConnectorDeadline } from './base.js';
import { descriptorResultContract, projectStandardResult, toConnectorError } from './result.js';

const DEFAULT_CONNECT_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 60;

export type HttpConnectorOptions = {
  connectAttempts?: number;
  retryDelayMs?: number;
  /** Test seam: builds the McpClient bound to a concrete transport. */
  clientFactory?: () => McpClient;
  protocolVersion?: string;
};

/**
 * HTTP downstream connector on the unified client facade. Connection retries
 * are bounded and cover the connect phase only; a submitted tools/call is
 * never replayed. A permanently broken transport is dropped so the next
 * operation builds a fresh connection instead of reusing it.
 */
export class HttpConnector implements DownstreamConnector {
  private client: McpClient | null = null;
  private connectPromise: Promise<void> | undefined;
  private closing = false;
  private candidate: McpClient | null = null;
  private closePromise: Promise<void> | undefined;
  private readonly shutdownController = new AbortController();
  private readonly retiringClients = new Set<Promise<void>>();
  private discoveredClient: McpClient | null = null;
  private resultContracts = new Map<string, ResultContract>();

  public constructor(
    private readonly endpoint: string,
    private readonly timeoutMs = 30000,
    private readonly options: HttpConnectorOptions = {}
  ) {}

  public async listTools(): Promise<BackendTool[]> {
    const client = await this.ensureConnected();
    try {
      const descriptors = await client.discoverTools({ timeoutMs: this.timeoutMs });
      this.rememberContracts(client, descriptors);
      return descriptors.map(toBackendTool);
    } catch (error) {
      this.dropBrokenClient(error, client);
      throw toConnectorError(error);
    }
  }

  public async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: CallContextOptions
  ): Promise<DownstreamToolCallResult> {
    return withConnectorDeadline(this.timeoutMs, signal, (budgetSignal, remainingMs) =>
      this.callWithinBudget(name, args, budgetSignal, remainingMs, context)
    );
  }

  private async callWithinBudget(
    name: string,
    args: unknown,
    signal: AbortSignal,
    remainingMs: () => number,
    context?: CallContextOptions
  ): Promise<DownstreamToolCallResult> {
    const start = Date.now();
    const input = normalizeInput(args);
    const client = await awaitWithSignal(this.ensureConnected(), signal);
    try {
      if (context?.resultContract === undefined && this.discoveredClient !== client) {
        try {
          this.rememberContracts(
            client,
            await client.discoverTools({ timeoutMs: remainingMs(), signal })
          );
        } catch (error) {
          if (
            error instanceof McpClientError &&
            error.category === 'invalid_request' &&
            error.details?.jsonRpcCode === -32601
          )
            this.rememberContracts(client, []);
          else throw error;
        }
      }
      const resultContract =
        context?.resultContract ?? this.resultContracts.get(name) ?? 'legacy-auto';
      const identity = {
        ...(context?.traceId !== undefined ? { traceId: context.traceId } : {}),
        ...(context?.runId !== undefined ? { runId: context.runId } : {}),
        ...(context?.taskId !== undefined ? { taskId: context.taskId } : {})
      };
      const native = await client.callToolResult(name, input, {
        timeoutMs: remainingMs(),
        ...(signal ? { signal } : {}),
        ...(Object.keys(identity).length ? { context: identity } : {}),
        resultContract
      });
      return {
        durationMs: Date.now() - start,
        output: projectStandardResult(native, resultContract),
        native
      };
    } catch (error) {
      this.dropBrokenClient(error, client);
      throw toConnectorError(error);
    }
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.shutdownController.abort(new DOMException('Connector closed', 'AbortError'));
    this.closePromise = (async () => {
      const clients = new Set([this.client, this.candidate]);
      this.client = null;
      await Promise.allSettled(
        [...clients]
          .filter((client): client is McpClient => client !== null)
          .map((client) => client.close())
      );
      await this.connectPromise?.catch(() => undefined);
      // A retired connection remains owned while its DELETE/transport close
      // is in flight, even after a new independent operation reconnects.
      await Promise.allSettled([...this.retiringClients]);
    })();
    return this.closePromise;
  }

  private dropBrokenClient(error: unknown, failedClient: McpClient): void {
    const classified = toConnectorError(error);
    if (
      classified.category === 'backend_unavailable' &&
      classified.permanent &&
      this.client === failedClient
    ) {
      this.client = null;
      const retiring = failedClient
        .close()
        .catch(() => undefined)
        .finally(() => {
          this.retiringClients.delete(retiring);
        });
      this.retiringClients.add(retiring);
    }
  }

  private rememberContracts(client: McpClient, descriptors: readonly ToolDescriptor[]): void {
    this.discoveredClient = client;
    this.resultContracts = new Map(
      descriptors.map((tool) => [tool.name, descriptorResultContract(tool)])
    );
  }

  private buildClient(): McpClient {
    if (this.options.clientFactory) {
      return this.options.clientFactory();
    }
    // SDK transport classes type optional callbacks as `| undefined`, which
    // conflicts with exactOptionalPropertyTypes on the Transport interface.
    let transport: Transport = new StreamableHTTPClientTransport(
      new URL(this.endpoint)
    ) as unknown as Transport;
    if (this.options.protocolVersion) {
      transport = pinProtocolVersion(transport, this.options.protocolVersion);
    }
    return new McpClient(transport, { timeoutMs: this.timeoutMs });
  }

  private ensureConnected(): Promise<McpClient> {
    if (this.client) {
      return Promise.resolve(this.client);
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connectWithRetry(this.shutdownController.signal).finally(() => {
        this.connectPromise = undefined;
      });
    }
    return this.connectPromise.then(() => {
      if (!this.client) {
        throw new DownstreamConnectorError('backend_unavailable', 'Connector is closed');
      }
      return this.client;
    });
  }

  private async connectWithRetry(signal?: AbortSignal): Promise<void> {
    const attempts = this.options.connectAttempts ?? DEFAULT_CONNECT_ATTEMPTS;
    const retryDelayMs = this.options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (this.closing) {
        throw new DownstreamConnectorError('backend_unavailable', 'Connector is closed');
      }
      const candidate = this.buildClient();
      this.candidate = candidate;
      try {
        await candidate.connect();
        if (this.closing) {
          await candidate.close();
          throw new DownstreamConnectorError('backend_unavailable', 'Connector is closed');
        }
        this.client = candidate;
        this.candidate = null;
        return;
      } catch (error) {
        await candidate.close().catch(() => undefined);
        this.candidate = null;
        lastError = toConnectorError(error);
        if (
          this.closing ||
          (lastError instanceof DownstreamConnectorError &&
            (lastError.category === 'cancelled' || lastError.permanent)) ||
          attempt === attempts
        ) {
          throw lastError;
        }
        await sleep(retryDelayMs, undefined, { signal });
      }
    }
    throw toConnectorError(lastError);
  }
}

function toBackendTool(descriptor: ToolDescriptor): BackendTool {
  return {
    name: descriptor.name,
    description: descriptor.description ?? '',
    descriptor
  };
}

function normalizeInput(args: unknown): JsonObject {
  if (args === undefined || args === null) {
    return {};
  }
  if (isJsonObject(args)) {
    return args;
  }
  throw new DownstreamConnectorError(
    'invalid_request',
    'Tool call arguments must be a JSON object'
  );
}
