import type { RiskLevel, RunContext, StandardToolResult, TransportKind } from '@ai-mcp/shared';

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
  metadata?: Partial<ToolCapabilityMetadata>;
};

export type GatewayServerOptions = {
  name?: string;
  version?: string;
  tenantId?: string;
  who?: string;
  agent?: string;
  runContext?: Partial<RunContext>;
  policy?: GatewayPolicyOptions;
  capabilities?: GatewayCapabilityOptions;
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
  riskPolicy?: RiskPolicy;
  conditionalAllow?: ConditionalAllowRule[];
};

export type PolicyDecision = {
  allowed: boolean;
  reason?: string;
  reasonCode?: 'RATE_LIMIT' | 'ALLOWLIST' | 'RISK_LEVEL' | 'CONDITIONAL_ALLOW';
};

export type RequestContext = {
  tenantId: string;
  toolName: string;
  traceId: string;
  now: number;
  riskLevel: RiskLevel;
  tags: string[];
  requiredPermissions: string[];
};

export type ToolVisibility = 'public' | 'internal' | 'hidden';

export type ToolCapabilityMetadata = {
  riskLevel: RiskLevel;
  requiredPermissions: string[];
  tags: string[];
  version: string;
  visibility: ToolVisibility;
};

export type GatewayCapabilityOptions = {
  defaultRiskLevel?: RiskLevel;
  toolOverrides?: Record<string, Partial<ToolCapabilityMetadata>>;
};

export type RiskPolicy = {
  maxAllowedLevel?: RiskLevel;
  denyLevels?: RiskLevel[];
};

export type ConditionalAllowRule = {
  toolName?: string;
  minRiskLevel?: RiskLevel;
  allowedTenants?: string[];
  requiredTags?: string[];
};

export type MappedToolCallResult = {
  backendId: string;
  backendToolName: string;
  durationMs: number;
  output: StandardToolResult;
};

export type AuditEvent = {
  timestamp: string;
  tenantId: string;
  action: 'tools/call';
  toolName: string;
  traceId: string;
  decision: 'allow' | 'deny';
  who?: string;
  agent?: string;
  runId?: string;
  taskId?: string;
  downstream?: {
    backendId: string;
    backendToolName: string;
  };
  durationMs?: number;
  outputSummary?: string;
  capabilityRiskLevel?: RiskLevel;
  policyReasonCode?: PolicyDecision['reasonCode'];
  errorCategory?: string;
  inputHash?: string;
  reason?: string;
};

export type AuditStore = {
  record(event: AuditEvent): Promise<void>;
};
