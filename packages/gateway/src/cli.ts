#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { McpGatewayServer } from './gateway-server.js';
import { JsonlAuditStore } from './audit-jsonl.js';
import type { BackendSpec, GatewayPolicyOptions } from './types.js';

type GatewayConfig = {
  backends: BackendSpec[];
  tenantId?: string;
  who?: string;
  agent?: string;
  resultContracts?: {
    toolOverrides?: Record<string, 'native-json/v1' | 'standard/v1'>;
  };
  runContext?: {
    runId?: string;
  };
  policy?: GatewayPolicyOptions;
  capabilities?: {
    defaultRiskLevel?: 'low' | 'medium' | 'high' | 'critical';
    toolOverrides?: Record<
      string,
      {
        riskLevel?: 'low' | 'medium' | 'high' | 'critical';
        requiredPermissions?: string[];
        tags?: string[];
        version?: string;
        visibility?: 'public' | 'internal' | 'hidden';
      }
    >;
  };
  allowLegacyHttpSse?: boolean;
  auditFilePath?: string;
  auditHashSecret?: string;
  httpSession?: {
    sessionMode?: 'stateful' | 'stateless';
    sessionIdleTimeoutMs?: number;
    maxSessions?: number;
  };
};

const rateLimitPolicySchema = z.object({
  windowMs: z.number().int().positive(),
  maxRequests: z.number().int().positive()
});
const riskLevelSchema = z.enum(['low', 'medium', 'high', 'critical']);
const conditionalAllowRuleSchema = z.object({
  toolName: z.string().min(1).optional(),
  minRiskLevel: riskLevelSchema.optional(),
  allowedTenants: z.array(z.string().min(1)).optional(),
  requiredTags: z.array(z.string().min(1)).optional()
});
const toolCapabilityOverrideSchema = z.object({
  riskLevel: riskLevelSchema.optional(),
  requiredPermissions: z.array(z.string().min(1)).optional(),
  tags: z.array(z.string().min(1)).optional(),
  version: z.string().min(1).optional(),
  visibility: z.enum(['public', 'internal', 'hidden']).optional()
});

const resultContractSchema = z.enum(['native-json/v1', 'standard/v1', 'legacy-auto']);
const httpBackendSchema = z.object({
  id: z.string().min(1),
  transport: z.literal('http'),
  endpoint: z.string().url(),
  timeoutMs: z.number().int().positive().optional(),
  protocolVersion: z.enum(['2025-11-25', '2025-03-26', '2024-11-05']).optional(),
  resultContract: resultContractSchema.optional()
});

const stdioBackendSchema = z.object({
  id: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  protocolVersion: z.enum(['2025-11-25', '2025-03-26', '2024-11-05']).optional(),
  resultContract: resultContractSchema.optional()
});

const gatewayConfigSchema = z.object({
  backends: z.array(z.union([httpBackendSchema, stdioBackendSchema])).min(1),
  tenantId: z.string().min(1).optional(),
  who: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  runContext: z
    .object({
      runId: z.string().min(1).optional()
    })
    .optional(),
  resultContracts: z
    .object({
      toolOverrides: z
        .record(z.string().min(1), z.enum(['native-json/v1', 'standard/v1']))
        .optional()
    })
    .optional(),
  policy: z
    .object({
      allowTools: z.array(z.string()).optional(),
      rateLimit: rateLimitPolicySchema.optional(),
      riskPolicy: z
        .object({
          maxAllowedLevel: riskLevelSchema.optional(),
          denyLevels: z.array(riskLevelSchema).optional()
        })
        .optional(),
      conditionalAllow: z.array(conditionalAllowRuleSchema).optional()
    })
    .optional(),
  capabilities: z
    .object({
      defaultRiskLevel: riskLevelSchema.optional(),
      toolOverrides: z.record(z.string(), toolCapabilityOverrideSchema).optional()
    })
    .optional(),
  allowLegacyHttpSse: z.boolean().optional(),
  auditFilePath: z.string().optional(),
  auditHashSecret: z.string().min(1).optional(),
  httpSession: z
    .object({
      sessionMode: z.enum(['stateful', 'stateless']).optional(),
      sessionIdleTimeoutMs: z.number().int().positive().optional(),
      maxSessions: z.number().int().positive().optional()
    })
    .optional()
});

function getArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.findIndex((item) => item === `--${name}`);
  if (index < 0) {
    return fallback;
  }
  return process.argv[index + 1] ?? fallback;
}

function getBooleanArg(name: string): boolean | undefined {
  const value = getArg(name);
  if (value === undefined) {
    return undefined;
  }
  if (value === 'true') {
    return true;
  }
  if (value === 'false') {
    return false;
  }
  throw new Error(`Invalid boolean value for --${name}: ${value}`);
}

function resolveBackends(backends: BackendSpec[], configPath: string): BackendSpec[] {
  const configDir = dirname(resolve(configPath));

  return backends.map((backend) => {
    if (backend.transport !== 'stdio') {
      return backend;
    }

    if (!backend.cwd) {
      return backend;
    }

    return {
      ...backend,
      cwd: resolve(configDir, backend.cwd)
    };
  });
}

async function main(): Promise<void> {
  const configPath = getArg('config');
  if (!configPath) {
    throw new Error('Missing required argument --config <path-to-json>');
  }

  const transport = getArg('transport', 'http');
  const port = Number(getArg('port', '4000'));
  if (transport !== 'http' && transport !== 'stdio') {
    throw new Error(`Unsupported transport: ${transport}`);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  const raw = readFileSync(configPath, 'utf8');
  const parsedJson = JSON.parse(raw) as unknown;
  const config = gatewayConfigSchema.parse(parsedJson) as GatewayConfig;

  const overrideTenantId = getArg('tenantId');
  const overrideAllowLegacyHttpSse = getBooleanArg('allowLegacyHttpSse');
  const overrideAuditFilePath = getArg('auditFilePath');
  const overrideAuditHashSecret = getArg('auditHashSecret');

  const effectiveConfig: GatewayConfig = {
    ...config,
    ...(overrideTenantId ? { tenantId: overrideTenantId } : {}),
    ...(overrideAllowLegacyHttpSse !== undefined
      ? { allowLegacyHttpSse: overrideAllowLegacyHttpSse }
      : {}),
    ...(overrideAuditFilePath ? { auditFilePath: overrideAuditFilePath } : {}),
    ...(overrideAuditHashSecret ? { auditHashSecret: overrideAuditHashSecret } : {})
  };

  const resolvedBackends = resolveBackends(effectiveConfig.backends, configPath);
  const configDir = dirname(resolve(configPath));
  const resolvedAuditFilePath = effectiveConfig.auditFilePath
    ? resolve(configDir, effectiveConfig.auditFilePath)
    : undefined;

  const gateway = new McpGatewayServer(resolvedBackends, {
    ...(effectiveConfig.tenantId ? { tenantId: effectiveConfig.tenantId } : {}),
    ...(effectiveConfig.who ? { who: effectiveConfig.who } : {}),
    ...(effectiveConfig.agent ? { agent: effectiveConfig.agent } : {}),
    ...(effectiveConfig.runContext ? { runContext: effectiveConfig.runContext } : {}),
    ...(effectiveConfig.resultContracts
      ? { resultContracts: effectiveConfig.resultContracts }
      : {}),
    ...(effectiveConfig.policy ? { policy: effectiveConfig.policy } : {}),
    ...(effectiveConfig.capabilities ? { capabilities: effectiveConfig.capabilities } : {}),
    ...(effectiveConfig.allowLegacyHttpSse !== undefined
      ? { allowLegacyHttpSse: effectiveConfig.allowLegacyHttpSse }
      : {}),
    ...(resolvedAuditFilePath ? { auditStore: new JsonlAuditStore(resolvedAuditFilePath) } : {}),
    ...(effectiveConfig.auditHashSecret ? { auditHashSecret: effectiveConfig.auditHashSecret } : {})
  });
  await gateway.initialize();

  if (transport === 'stdio') {
    gateway.startStdio();
    process.stderr.write('mcp-gateway started on stdio\n');
    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      // Close downstream connectors before exiting; without this the stdio
      // backend child processes would be orphaned.
      await gateway.close().catch(() => undefined);
      process.stderr.write(`mcp-gateway stopped (${signal})\n`);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    return;
  }

  if (transport === 'http') {
    const sessionMode =
      getArg('sessionMode') ?? effectiveConfig.httpSession?.sessionMode ?? 'stateful';
    if (sessionMode !== 'stateful' && sessionMode !== 'stateless') {
      throw new Error(`Invalid sessionMode: ${sessionMode}`);
    }
    const httpServer = gateway.startHttp({
      port,
      path: '/mcp',
      sessionMode,
      ...(effectiveConfig.httpSession?.sessionIdleTimeoutMs !== undefined
        ? { sessionIdleTimeoutMs: effectiveConfig.httpSession.sessionIdleTimeoutMs }
        : {}),
      ...(effectiveConfig.httpSession?.maxSessions !== undefined
        ? { maxSessions: effectiveConfig.httpSession.maxSessions }
        : {})
    });
    process.stderr.write(`mcp-gateway started on http://localhost:${port}/mcp (${sessionMode})\n`);

    let shuttingDown = false;
    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) {
        return;
      }
      shuttingDown = true;
      await gateway.close().catch(() => undefined);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      process.stderr.write(`mcp-gateway stopped (${signal})\n`);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    return;
  }

  throw new Error(`Unsupported transport: ${transport}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
