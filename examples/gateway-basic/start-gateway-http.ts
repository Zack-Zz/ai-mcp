import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { McpGatewayServer, type BackendSpec, type GatewayPolicyOptions } from '@ai-mcp/gateway';

type Config = {
  backends: BackendSpec[];
  tenantId?: string;
  policy?: GatewayPolicyOptions;
  allowLegacyHttpSse?: boolean;
};

const configPath = resolve(process.cwd(), 'gateway-config.json');
const raw = readFileSync(configPath, 'utf8');
const config = JSON.parse(raw) as Config;

const server = new McpGatewayServer(config.backends, {
  ...(config.tenantId ? { tenantId: config.tenantId } : {}),
  ...(config.policy ? { policy: config.policy } : {}),
  ...(config.allowLegacyHttpSse !== undefined
    ? { allowLegacyHttpSse: config.allowLegacyHttpSse }
    : {})
});

await server.initialize();
server.startHttp({ port: 4100, path: '/mcp' });

console.log('gateway started at http://localhost:4100/mcp');
