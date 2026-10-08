import type {
  JsonObject,
  NativeToolResult,
  ResolvedResultContract,
  ResultContract,
  RiskLevel,
  RunContext,
  StandardToolResult,
  ToolDescriptor,
  TransportKind
} from '@ai-mcp/shared';

export type SupportedProtocolVersion = '2025-11-25' | '2025-03-26' | '2024-11-05';

export type BackendKind = Extract<TransportKind, 'http' | 'stdio'>;

export type HttpBackendSpec = {
  id: string;
  transport: 'http';
  endpoint: string;
  timeoutMs?: number;
  protocolVersion?: SupportedProtocolVersion;
  resultContract?: ResultContract;
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
  resultContract?: ResultContract;
};

export type BackendSpec = HttpBackendSpec | StdioBackendSpec;

export type GatewayTool = {
  publicName: string;
  backendId: string;
  backendToolName: string;
  description: string;
  inputSchema?: ToolDescriptor['inputSchema'];
  outputSchema?: ToolDescriptor['outputSchema'];
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
  shutdownGraceMs?: number;
  allowLegacyHttpSse?: boolean;
  auditHashSecret?: string;
  resultContracts?: {
    toolOverrides?: Record<string, ResolvedResultContract>;
  };
  /** Test/embedding seam replacing default connector construction. */
  connectorFactory?: import('./gateway-core.js').ConnectorFactory;
};

export type StartGatewayHttpOptions = {
  port: number;
  path?: string;
  /** Gateway default is stateful (sessions); 'stateless' serves per request. */
  sessionMode?: 'stateful' | 'stateless';
  sessionIdleTimeoutMs?: number;
  maxSessions?: number;
  maxBodySizeBytes?: number;
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
  native: NativeToolResult;
};

export type AuditOutcome = 'success' | 'tool_error' | 'protocol_error' | 'cancelled';

export type AuditEvent = {
  timestamp: string;
  tenantId: string;
  action: 'tools/call';
  toolName: string;
  traceId: string;
  decision: 'allow' | 'deny';
  /** Policy decision and execution outcome are recorded separately. */
  outcome?: AuditOutcome;
  resultCode?: string;
  executionDisposition?: 'not_started' | 'completed' | 'unknown';
  invocationId?: string;
  requestId?: string | number;
  mcpSessionId?: string;
  protocolVersion?: string;
  downstreamTraceId?: string;
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
  /** Service-owned stores may flush queued writes during shutdown. */
  close?(): Promise<void>;
};

export type { JsonObject };
