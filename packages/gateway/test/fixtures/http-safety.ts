import { McpGatewayServer } from '../../src/gateway-server.js';
import { createServer } from '../../../mcp-server/src/server.js';
import type { AddressInfo } from 'node:net';

const owner = process.argv[2] === 'gateway' ? new McpGatewayServer([]) : createServer();
if (owner instanceof McpGatewayServer) await owner.initialize();
const listener = owner.startHttp({ port: 0, sessionMode: 'stateful' });
listener.on('listening', () => process.send?.({ port: (listener.address() as AddressInfo).port }));
process.on('SIGTERM', () => {
  void owner.close().then(() => process.exit(0));
});
