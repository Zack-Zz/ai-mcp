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

const server = createServer();

if (transport === 'stdio') {
  server.startStdio();
  process.stderr.write('mcp-server started on stdio\n');
} else if (transport === 'http') {
  server.startHttp({ port });
  process.stderr.write(`mcp-server started on http://localhost:${port}/mcp\n`);
} else if (transport === 'sse') {
  if (ssePath) {
    server.startSse({ port, path: ssePath });
  } else {
    server.startSse({ port });
  }
  process.stderr.write(`mcp-server started on http://localhost:${port}${ssePath}\n`);
} else {
  process.stderr.write(`Unsupported transport: ${transport}\n`);
  process.exit(1);
}
