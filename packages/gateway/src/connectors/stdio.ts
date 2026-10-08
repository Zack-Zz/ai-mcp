import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
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
import { ClientOperations } from './client-operations.js';

export type StdioConnectorOptions = {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  protocolVersion?: string;
  /** Test seam for injecting a transport-bound client. */
  clientFactory?: () => McpClient;
};

/**
 * stdio downstream connector: one long-lived child process per connector,
 * owned by the gateway service. Connect failures leave no half-spawned
 * process behind (the client facade closes on failed handshakes), and close
 * terminates the child exactly once.
 */
export class StdioConnector implements DownstreamConnector {
  private client: McpClient | null = null;
  private connectPromise: Promise<void> | undefined;
  private closing = false;
  private candidate: McpClient | null = null;
  private closePromise: Promise<void> | undefined;
  private readonly shutdownController = new AbortController();
  private readonly timeoutMs: number;
  private readonly retiringClients = new Map<McpClient, Promise<void>>();
  private readonly operations = new ClientOperations();
  private discoveredClient: McpClient | null = null;
  private resultContracts = new Map<string, ResultContract>();

  public constructor(private readonly options: StdioConnectorOptions) {
    this.timeoutMs = options.timeoutMs ?? 30000;
  }

  public async listTools(): Promise<BackendTool[]> {
    const { client, release } = await this.acquireClient();
    try {
      const descriptors = await client.discoverTools({ timeoutMs: this.timeoutMs });
      this.rememberContracts(client, descriptors);
      return descriptors.map(toBackendTool);
    } catch (error) {
      this.dropBrokenClient(error, client);
      throw toConnectorError(error);
    } finally {
      release();
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
    const { client, release } = await this.acquireClient(signal);
    try {
      let contracts = this.resultContracts;
      if (context?.resultContract === undefined && this.discoveredClient !== client) {
        try {
          contracts = this.rememberContracts(
            client,
            await client.discoverTools({ timeoutMs: remainingMs(), signal })
          );
        } catch (error) {
          if (
            error instanceof McpClientError &&
            error.category === 'invalid_request' &&
            error.details?.jsonRpcCode === -32601
          )
            contracts = this.rememberContracts(client, []);
          else throw error;
        }
      }
      const resultContract = context?.resultContract ?? contracts.get(name) ?? 'legacy-auto';
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
    } finally {
      release();
    }
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.shutdownController.abort(new DOMException('Connector closed', 'AbortError'));
    this.closePromise = (async () => {
      const clients = new Set([this.client, this.candidate, ...this.retiringClients.keys()]);
      this.client = null;
      this.discoveredClient = null;
      this.resultContracts.clear();
      await Promise.allSettled(
        [...clients]
          .filter((client): client is McpClient => client !== null)
          .map((client) => client.close())
      );
      await this.connectPromise?.catch(() => undefined);
      await Promise.allSettled([...this.retiringClients.values()]);
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
      this.retireClient(failedClient);
    }
  }

  private retireClient(failedClient: McpClient): void {
    this.client = null;
    this.discoveredClient = null;
    this.resultContracts.clear();
    const retiring = this.operations
      .waitForIdle(failedClient)
      .then(() => failedClient.close())
      .catch(() => undefined)
      .finally(() => {
        this.retiringClients.delete(failedClient);
      });
    this.retiringClients.set(failedClient, retiring);
  }

  private async acquireClient(
    signal?: AbortSignal
  ): Promise<{ client: McpClient; release: () => void }> {
    const client = await awaitWithSignal(this.ensureConnected(), signal);
    signal?.throwIfAborted();
    // Retirement or shutdown can win while a caller awaits admission.
    if (this.client !== client || this.closing) return this.acquireClient(signal);
    return { client, release: this.operations.acquire(client) };
  }

  private rememberContracts(
    client: McpClient,
    descriptors: readonly ToolDescriptor[]
  ): Map<string, ResultContract> {
    const contracts = new Map(
      descriptors.map((tool) => [tool.name, descriptorResultContract(tool)])
    );
    // An admitted operation may finish after retirement or service shutdown.
    // Its result belongs to that caller, not to the replacement connection.
    if (this.client === client && !this.closing) {
      this.discoveredClient = client;
      this.resultContracts = contracts;
    }
    return contracts;
  }

  private ensureConnected(): Promise<McpClient> {
    if (this.closing) {
      return Promise.reject(
        new DownstreamConnectorError('backend_unavailable', 'Connector is closed')
      );
    }
    if (this.client && !this.client.isConnected) this.retireClient(this.client);
    if (this.client) {
      return Promise.resolve(this.client);
    }
    if (!this.connectPromise) {
      this.connectPromise = this.connectOnce().finally(() => {
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

  private async connectOnce(): Promise<void> {
    if (this.closing) {
      throw new DownstreamConnectorError('backend_unavailable', 'Connector is closed');
    }
    const candidate = this.buildClient();
    this.candidate = candidate;
    try {
      await candidate.connect();
    } catch (error) {
      // stdio connect failures must not leave a half-spawned process.
      await candidate.close().catch(() => undefined);
      this.candidate = null;
      throw toConnectorError(error);
    }
    if (this.closing) {
      await candidate.close();
      throw new DownstreamConnectorError('backend_unavailable', 'Connector is closed');
    }
    this.client = candidate;
    this.candidate = null;
  }

  private buildClient(): McpClient {
    if (this.options.clientFactory) {
      return this.options.clientFactory();
    }
    const base: Transport = new StdioClientTransport({
      command: this.options.command,
      ...(this.options.args ? { args: this.options.args } : {}),
      ...(this.options.env ? { env: this.options.env } : {}),
      ...(this.options.cwd ? { cwd: this.options.cwd } : {})
    }) as unknown as Transport;
    const transport = this.options.protocolVersion
      ? pinProtocolVersion(base, this.options.protocolVersion)
      : base;
    return new McpClient(transport, { timeoutMs: this.timeoutMs });
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
