import { createTraceId, createInvocationId } from '@ai-mcp/shared';
import { adaptDownstreamResult } from './result-adapter.js';
import type {
  BackendSpec,
  GatewayServerOptions,
  GatewayTool,
  MappedToolCallResult
} from './types.js';
import type { CallContextOptions, DownstreamConnector } from './connectors/base.js';
import { DownstreamConnectorError } from './connectors/base.js';
import { HttpConnector } from './connectors/http.js';
import { StdioConnector } from './connectors/stdio.js';
import {
  buildCatalogEntries,
  CatalogError,
  type CatalogEntry,
  type GatewayCatalog
} from './tool-catalog.js';

export type ConnectorFactory = (backend: BackendSpec) => DownstreamConnector;

function defaultConnectorFactory(backend: BackendSpec): DownstreamConnector {
  if (backend.transport === 'http') {
    return new HttpConnector(backend.endpoint, backend.timeoutMs ?? 30000, {
      ...(backend.protocolVersion ? { protocolVersion: backend.protocolVersion } : {})
    });
  }

  return new StdioConnector({
    command: backend.command,
    ...(backend.args ? { args: backend.args } : {}),
    ...(backend.env ? { env: backend.env } : {}),
    ...(backend.cwd ? { cwd: backend.cwd } : {}),
    timeoutMs: backend.timeoutMs ?? 30000,
    ...(backend.protocolVersion ? { protocolVersion: backend.protocolVersion } : {})
  });
}

/**
 * Service-level backend manager. Holds connectors and the frozen tool
 * catalog; a refresh builds a candidate snapshot and swaps it in only when
 * every backend discovered successfully. Invokers read routing keys from the
 * captured entry, never from a mutable global map.
 */
export class McpGatewayCore {
  private readonly connectors = new Map<string, DownstreamConnector>();
  private catalog: GatewayCatalog | null = null;
  private closePromise: Promise<void> | undefined;

  public constructor(
    private readonly backends: BackendSpec[],
    private readonly connectorFactory: ConnectorFactory = defaultConnectorFactory,
    private readonly resultContracts: GatewayServerOptions['resultContracts'] = undefined
  ) {
    const seen = new Set<string>();
    for (const backend of backends) {
      if (seen.has(backend.id)) {
        throw new CatalogError('DUPLICATE_BACKEND', `Duplicate backend id: ${backend.id}`);
      }
      seen.add(backend.id);
      this.connectors.set(backend.id, this.connectorFactory(backend));
    }
  }

  public async refreshTools(): Promise<GatewayTool[]> {
    const candidates = [];
    for (const backend of this.backends) {
      const connector = this.connectors.get(backend.id);
      if (!connector) {
        throw new DownstreamConnectorError(
          'backend_unavailable',
          `Connector not found for backend: ${backend.id}`
        );
      }
      const tools = await connector.listTools();
      candidates.push({
        id: backend.id,
        ...(backend.resultContract !== undefined ? { resultContract: backend.resultContract } : {}),
        tools: tools.map((tool) => tool.descriptor),
        metadataByName: Object.fromEntries(
          tools
            .filter((tool) => tool.metadata !== undefined)
            .map((tool) => [tool.name, tool.metadata!])
        )
      });
    }

    const nextCatalog = buildCatalogEntries({
      backends: candidates,
      ...(this.resultContracts?.toolOverrides
        ? { options: { toolOverrides: this.resultContracts.toolOverrides } }
        : {})
    });

    this.catalog = nextCatalog;
    return this.listMappedTools();
  }

  public listMappedTools(): GatewayTool[] {
    if (!this.catalog) {
      return [];
    }
    return this.catalog.entries.map((entry) => ({
      publicName: entry.publicName,
      backendId: entry.backendId,
      backendToolName: entry.backendToolName,
      ...(entry.metadata ? { metadata: entry.metadata } : {}),
      description: entry.advertised.description ?? '',
      inputSchema: entry.advertised.inputSchema,
      ...(entry.advertised.outputSchema !== undefined
        ? { outputSchema: entry.advertised.outputSchema }
        : {})
    }));
  }

  public getCatalog(): GatewayCatalog | null {
    return this.catalog;
  }

  public getCatalogRevision(): string | null {
    return this.catalog?.revision ?? null;
  }

  public async callMappedTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
    context?: CallContextOptions
  ): Promise<MappedToolCallResult & { entry: CatalogEntry }> {
    const entry = this.catalog?.findByPublicName(name);
    if (!entry) {
      throw new DownstreamConnectorError('invalid_request', `Mapped tool not found: ${name}`);
    }
    const connector = this.connectors.get(entry.backendId);
    if (!connector) {
      throw new DownstreamConnectorError(
        'backend_unavailable',
        `Connector not found for backend: ${entry.backendId}`
      );
    }

    if (args !== undefined && args !== null) {
      const inputCheck = entry.inputValidator.validate(args);
      if (!inputCheck.valid) {
        throw new DownstreamConnectorError(
          'invalid_request',
          `Invalid input for tool ${name}: ${inputCheck.issues
            .map((issue) => `${issue.path || '(root)'} ${issue.message}`)
            .join('; ')}`,
          { issues: inputCheck.issues }
        );
      }
    }

    const traceId = context?.traceId ?? createTraceId();
    const invocationId = createInvocationId();
    const callContext: CallContextOptions = { ...context, traceId, resultContract: entry.contract };
    const result = await connector.callTool(entry.backendToolName, args, signal, callContext);
    // Connector.output is a compatibility projection; the frozen catalog
    // decides semantics even for embedding connectors returning stale output.
    const adapted = adaptDownstreamResult(result.native, entry, {
      traceId,
      invocationId,
      ...(context?.runId !== undefined ? { runId: context.runId } : {}),
      ...(context?.taskId !== undefined ? { taskId: context.taskId } : {})
    });
    if (adapted.kind === 'failure')
      throw new DownstreamConnectorError('invalid_result', adapted.fault.message, adapted.fault);

    return {
      backendId: entry.backendId,
      backendToolName: entry.backendToolName,
      durationMs: result.durationMs,
      output: adapted.standard,
      native: result.native,
      entry
    };
  }

  /** Closes every connector; one failure never blocks the others. */
  public async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }
    this.closePromise = (async () => {
      const closers = Array.from(this.connectors.values(), (connector) =>
        connector.close().catch((error: unknown) => error)
      );
      await Promise.allSettled(closers);
    })();
    return this.closePromise;
  }
}
