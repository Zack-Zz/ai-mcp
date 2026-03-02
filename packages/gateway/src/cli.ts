#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { McpGatewayServer } from './gateway-server.js';
import { JsonlAuditStore } from './audit-jsonl.js';
import type { BackendSpec, GatewayPolicyOptions } from './types.js';

type GatewayConfig = {
  backends: BackendSpec[];
  tenantId?: string;
  policy?: GatewayPolicyOptions;
  allowLegacyHttpSse?: boolean;
  auditFilePath?: string;
};

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
  const config = JSON.parse(raw) as GatewayConfig;

  if (!Array.isArray(config.backends) || config.backends.length === 0) {
    throw new Error('config.backends must be a non-empty array');
  }

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
    ...(resolvedAuditFilePath ? { auditStore: new JsonlAuditStore(resolvedAuditFilePath) } : {})
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
