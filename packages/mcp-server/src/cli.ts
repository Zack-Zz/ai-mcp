#!/usr/bin/env node
import { createServer } from './server.js';

function getArg(name: string, fallback?: string): string | undefined {
  const index = process.argv.findIndex((item) => item === `--${name}`);
  if (index < 0) {
    return fallback;
  }
  return process.argv[index + 1] ?? fallback;
}

const transport = getArg('transport', 'stdio');
const port = Number(getArg('port', '3000'));
const ssePath = getArg('path', '/sse');
const sessionMode = getArg('sessionMode');

const server = createServer();
let httpServer: ReturnType<typeof server.startHttp> | ReturnType<typeof server.startSse> | null =
  null;

if (transport === 'stdio') {
  server.startStdio();
  process.stderr.write('mcp-server started on stdio\n');
} else if (transport === 'http') {
  const mode =
    sessionMode === 'stateful' ? 'stateful' : sessionMode === 'stateless' ? 'stateless' : undefined;
  httpServer = server.startHttp({ port, ...(mode ? { sessionMode: mode } : {}) });
  process.stderr.write(
    `mcp-server started on http://localhost:${port}/mcp (${mode ?? 'stateless'})\n`
  );
} else if (transport === 'sse') {
  if (ssePath) {
    httpServer = server.startSse({ port, path: ssePath });
  } else {
    httpServer = server.startSse({ port });
  }
  process.stderr.write(`mcp-server started on http://localhost:${port}${ssePath}\n`);
} else {
  process.stderr.write(`Unsupported transport: ${transport}\n`);
  process.exit(1);
}

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await server.close().catch(() => undefined);
  if (httpServer) {
    await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  }
  process.stderr.write(`mcp-server stopped (${signal})\n`);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
