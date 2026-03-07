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
  policy?: GatewayPolicyOptions;
  allowLegacyHttpSse?: boolean;
  auditFilePath?: string;
  auditHashSecret?: string;
};

const rateLimitPolicySchema = z.object({
  windowMs: z.number().int().positive(),
  maxRequests: z.number().int().positive()
});

const httpBackendSchema = z.object({
  id: z.string().min(1),
  transport: z.literal('http'),
  endpoint: z.string().url(),
  timeoutMs: z.number().int().positive().optional(),
  protocolVersion: z.enum(['2025-11-25', '2025-03-26', '2024-11-05']).optional()
});

const stdioBackendSchema = z.object({
  id: z.string().min(1),
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
  protocolVersion: z.enum(['2025-11-25', '2025-03-26', '2024-11-05']).optional()
});

const gatewayConfigSchema = z.object({
  backends: z.array(z.union([httpBackendSchema, stdioBackendSchema])).min(1),
  tenantId: z.string().min(1).optional(),
  policy: z
    .object({
      allowTools: z.array(z.string()).optional(),
      rateLimit: rateLimitPolicySchema.optional()
    })
    .optional(),
  allowLegacyHttpSse: z.boolean().optional(),
  auditFilePath: z.string().optional(),
  auditHashSecret: z.string().min(1).optional()
});

function getArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.findIndex((item) => item === `--${name}`);
  if (index < 0) {
    return fallback;
  }
  return process.argv[index + 1] ?? fallback;
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

  const raw = readFileSync(configPath, 'utf8');
  const parsedJson = JSON.parse(raw) as unknown;
  const config = gatewayConfigSchema.parse(parsedJson) as GatewayConfig;

  const resolvedBackends = resolveBackends(config.backends, configPath);
  const configDir = dirname(resolve(configPath));
  const resolvedAuditFilePath = config.auditFilePath
    ? resolve(configDir, config.auditFilePath)
    : undefined;

  const gateway = new McpGatewayServer(resolvedBackends, {
    ...(config.tenantId ? { tenantId: config.tenantId } : {}),
    ...(config.policy ? { policy: config.policy } : {}),
    ...(config.allowLegacyHttpSse !== undefined
      ? { allowLegacyHttpSse: config.allowLegacyHttpSse }
      : {}),
    ...(resolvedAuditFilePath ? { auditStore: new JsonlAuditStore(resolvedAuditFilePath) } : {}),
    ...(config.auditHashSecret ? { auditHashSecret: config.auditHashSecret } : {})
  });
  await gateway.initialize();

  if (transport === 'stdio') {
    gateway.startStdio();
    process.stderr.write('mcp-gateway started on stdio\n');
    return;
  }

  if (transport === 'http') {
    gateway.startHttp({ port, path: '/mcp' });
    process.stderr.write(`mcp-gateway started on http://localhost:${port}/mcp\n`);
    return;
  }

  throw new Error(`Unsupported transport: ${transport}`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
