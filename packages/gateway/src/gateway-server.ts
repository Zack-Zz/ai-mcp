import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import { createTraceId } from '@ai-mcp/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { McpGatewayCore } from './gateway-core.js';
import type { BackendSpec, GatewayServerOptions, StartGatewayHttpOptions } from './types.js';
import { InMemoryAuditStore } from './audit.js';
import { GatewayPolicyEngine } from './policy.js';
import { resolveProtocolVersion } from './protocol.js';

const defaultInputSchema = z.object({}).passthrough();
const HTTP_RPC_PATH = '/mcp';

type SdkTransport = Parameters<McpServer['connect']>[0];

export class McpGatewayServer {
  private readonly gatewayCore: McpGatewayCore;
  private readonly sdkServer: McpServer;
  private readonly policyEngine: GatewayPolicyEngine;
  private readonly auditStore: NonNullable<GatewayServerOptions['auditStore']>;
  private readonly tenantId: string;
  private readonly allowLegacyHttpSse: boolean;
  private connectedTransport: SdkTransport | null = null;

  public constructor(backends: BackendSpec[], options: GatewayServerOptions = {}) {
    this.gatewayCore = new McpGatewayCore(backends);
    this.policyEngine = new GatewayPolicyEngine(options.policy);
    this.auditStore = options.auditStore ?? new InMemoryAuditStore();
    this.tenantId = options.tenantId ?? 'default';
    this.allowLegacyHttpSse = options.allowLegacyHttpSse ?? false;
    this.sdkServer = new McpServer({
      name: options.name ?? 'ai-mcp-gateway',
      version: options.version ?? '0.1.0'
    });
  }

  public async initialize(): Promise<void> {
    const mappedTools = await this.gatewayCore.refreshTools();
    const visibleTools = new Set(
      this.policyEngine.filterVisibleTools(mappedTools.map((tool) => tool.publicName))
    );

    for (const tool of mappedTools) {
      if (!visibleTools.has(tool.publicName)) {
        continue;
      }

      this.sdkServer.registerTool(
        tool.publicName,
        {
          description: tool.description,
          inputSchema: defaultInputSchema
        },
        async (input, extra) => {
          const traceId = String(extra.requestId ?? createTraceId());
          const decision = this.policyEngine.authorizeCall({
            tenantId: this.tenantId,
            toolName: tool.publicName,
            traceId,
            now: Date.now()
          });

          if (!decision.allowed) {
            await this.auditStore.record({
              timestamp: new Date().toISOString(),
              tenantId: this.tenantId,
              action: 'tools/call',
              toolName: tool.publicName,
              traceId,
              decision: 'deny',
              ...(decision.reason ? { reason: decision.reason } : {})
            });
            throw new Error(decision.reason ?? 'policy denied');
          }

          const output = await this.gatewayCore.callMappedTool(
            tool.publicName,
            input,
            extra.signal
          );

          await this.auditStore.record({
            timestamp: new Date().toISOString(),
            tenantId: this.tenantId,
            action: 'tools/call',
            toolName: tool.publicName,
            traceId,
            decision: 'allow'
          });

          const serialized = JSON.stringify(output ?? {});
          if (typeof output === 'object' && output !== null) {
            return {
              content: [{ type: 'text', text: serialized }],
              structuredContent: output as Record<string, unknown>
            };
          }

          return {
            content: [{ type: 'text', text: serialized }]
          };
        }
      );
    }
  }

  public startStdio(): void {
    const transport = new StdioServerTransport() as SdkTransport;
    void this.connectTransport(transport);
  }

  public startHttp(options: StartGatewayHttpOptions): ReturnType<typeof createHttpServer> {
    const transport = new StreamableHTTPServerTransport();
    void this.connectTransport(transport as SdkTransport);

    const path = options.path ?? HTTP_RPC_PATH;
    const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (!req.url?.startsWith(path)) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not Found' }));
        return;
      }

      // Node may expose repeated headers as string[], normalize to first value.
      const protocolHeader = Array.isArray(req.headers['mcp-protocol-version'])
        ? req.headers['mcp-protocol-version'][0]
        : req.headers['mcp-protocol-version'];
      const checkedProtocol = resolveProtocolVersion(protocolHeader, {
        allowLegacyHttpSse: this.allowLegacyHttpSse
      });
      if (!checkedProtocol.ok) {
        res.writeHead(checkedProtocol.statusCode, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'unknown',
            error: {
              code: 'INVALID_PARAMS',
              message: checkedProtocol.message,
              traceId: createTraceId()
            }
          })
        );
        return;
      }

      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            id: 'unknown',
            error: {
              code: 'INTERNAL',
              message: error instanceof Error ? error.message : String(error),
              traceId: createTraceId()
            }
          })
        );
      }
    });

    server.listen(options.port);
    return server;
  }

  public async close(): Promise<void> {
    await this.sdkServer.close();
    this.connectedTransport = null;
    await this.gatewayCore.close();
  }

  public getInMemoryAuditEvents(): ReturnType<InMemoryAuditStore['list']> {
    if (this.auditStore instanceof InMemoryAuditStore) {
      return this.auditStore.list();
    }
    return [];
  }

  private async connectTransport(transport: SdkTransport): Promise<void> {
    if (this.connectedTransport) {
      await this.sdkServer.close();
      this.connectedTransport = null;
    }

    await this.sdkServer.connect(transport);
    this.connectedTransport = transport;
  }
}
