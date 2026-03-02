import type { TransportKind } from '@ai-mcp/shared';

export type SupportedProtocolVersion = '2025-11-25' | '2025-03-26' | '2024-11-05';

export type BackendKind = Extract<TransportKind, 'http' | 'stdio'>;

export type HttpBackendSpec = {
  id: string;
  transport: 'http';
  endpoint: string;
  timeoutMs?: number;
  protocolVersion?: SupportedProtocolVersion;
};

export type StdioBackendSpec = {
  id: string;
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  protocolVersion?: SupportedProtocolVersion;
};

export type BackendSpec = HttpBackendSpec | StdioBackendSpec;

export type GatewayTool = {
  publicName: string;
  backendId: string;
  backendToolName: string;
  description: string;
};

export type GatewayServerOptions = {
  name?: string;
  version?: string;
  tenantId?: string;
  policy?: GatewayPolicyOptions;
  auditStore?: AuditStore;
  allowLegacyHttpSse?: boolean;
  auditHashSecret?: string;
};

export type StartGatewayHttpOptions = {
  port: number;
  path?: string;
};

export type RateLimitPolicy = {
  windowMs: number;
  maxRequests: number;
};

export type GatewayPolicyOptions = {
  allowTools?: string[];
  rateLimit?: RateLimitPolicy;
};

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
};

export type RequestContext = {
  tenantId: string;
  toolName: string;
  traceId: string;
  now: number;
};

export type AuditEvent = {
  timestamp: string;
  tenantId: string;
  action: 'tools/call';
  toolName: string;
  traceId: string;
  decision: 'allow' | 'deny';
  inputHash?: string;
  reason?: string;
};

export type AuditStore = {
  record(event: AuditEvent): Promise<void>;
};
