#!/usr/bin/env node
import { createClient } from './client.js';

function getArg(name: string): string | undefined {
  const index = process.argv.findIndex((item) => item === `--${name}`);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

function getTransport(): 'stdio' | 'http' | 'sse' {
  const transport = getArg('transport') ?? 'http';
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    throw new Error(`Unsupported transport: ${transport}`);
  }
  return transport;
}

async function main(): Promise<void> {
  const [domain, action, name] = process.argv.slice(2);

  if (domain !== 'tools' || !action) {
    process.stderr.write(
      'Usage: mcp-client tools list|call <name> --transport <stdio|http|sse> --endpoint <url-or-command> [--json <payload>]\n'
    );
    process.exit(1);
  }

  const transport = getTransport();
  const endpoint = getArg('endpoint');
  const payload = getArg('json');

  if (transport === 'stdio' && !endpoint) {
    throw new Error(
      'stdio transport requires --endpoint command, e.g. --endpoint "node packages/mcp-server/dist/cli.js --transport stdio"'
    );
  }

  const computedEndpoint =
    endpoint ??
    (transport === 'http' ? 'http://localhost:3000/mcp' : 'http://localhost:3001/sse/call');

  const client = createClient({
    transport,
    endpoint: computedEndpoint
  });

  try {
    if (action === 'list') {
      const tools = await client.listTools();
      process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
      return;
    }

    if (action === 'call') {
      if (!name) {
        throw new Error('tool name is required for call action');
      }
      const input = payload ? JSON.parse(payload) : {};
      const output = await client.callTool(name as 'echo' | 'time', input);
      process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`);
      return;
    }

    throw new Error(`Unsupported action: ${action}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
