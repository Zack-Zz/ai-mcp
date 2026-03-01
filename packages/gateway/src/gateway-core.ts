import type { BackendSpec, GatewayTool } from './types.js';
import type { DownstreamConnector } from './connectors/base.js';
import { HttpConnector } from './connectors/http.js';
import { StdioConnector } from './connectors/stdio.js';

export type ConnectorFactory = (backend: BackendSpec) => DownstreamConnector;

function defaultConnectorFactory(backend: BackendSpec): DownstreamConnector {
  if (backend.transport === 'http') {
    return new HttpConnector(backend.endpoint, backend.timeoutMs ?? 30000);
  }

  return new StdioConnector({
    command: backend.command,
    ...(backend.args ? { args: backend.args } : {}),
    ...(backend.env ? { env: backend.env } : {}),
    ...(backend.cwd ? { cwd: backend.cwd } : {}),
    timeoutMs: backend.timeoutMs ?? 30000
  });
}

export class McpGatewayCore {
  private readonly connectors = new Map<string, DownstreamConnector>();
  private readonly toolMappings = new Map<string, { backendId: string; backendToolName: string }>();
  private tools: GatewayTool[] = [];

  public constructor(
    private readonly backends: BackendSpec[],
    private readonly connectorFactory: ConnectorFactory = defaultConnectorFactory
  ) {
    for (const backend of backends) {
      this.connectors.set(backend.id, this.connectorFactory(backend));
    }
  }

  public async refreshTools(): Promise<GatewayTool[]> {
    const nextTools: GatewayTool[] = [];
    const nextMappings = new Map<string, { backendId: string; backendToolName: string }>();

    for (const backend of this.backends) {
      const connector = this.connectors.get(backend.id);
      if (!connector) {
        throw new Error(`Connector not found for backend: ${backend.id}`);
      }

      const tools = await connector.listTools();
      for (const tool of tools) {
        const publicName = `${backend.id}__${tool.name}`;
        if (nextMappings.has(publicName)) {
          throw new Error(`Duplicate mapped tool name: ${publicName}`);
        }

        nextTools.push({
          publicName,
          backendId: backend.id,
          backendToolName: tool.name,
          description: tool.description
        });
        nextMappings.set(publicName, {
          backendId: backend.id,
          backendToolName: tool.name
        });
      }
    }

    this.tools = nextTools;
    this.toolMappings.clear();
    for (const [name, mapping] of nextMappings) {
      this.toolMappings.set(name, mapping);
    }

    return this.tools;
  }

  public listMappedTools(): GatewayTool[] {
    return this.tools.slice();
  }

  public async callMappedTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown> {
    const mapping = this.toolMappings.get(name);
    if (!mapping) {
      throw new Error(`Mapped tool not found: ${name}`);
    }

    const connector = this.connectors.get(mapping.backendId);
    if (!connector) {
      throw new Error(`Connector not found for backend: ${mapping.backendId}`);
    }

    return await connector.callTool(mapping.backendToolName, args, signal);
  }

  public async close(): Promise<void> {
    for (const connector of this.connectors.values()) {
      await connector.close();
    }
  }
}
