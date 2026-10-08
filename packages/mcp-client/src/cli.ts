#!/usr/bin/env node
import { isJsonObject, type NativeToolResult } from '@ai-mcp/shared';
import { createClient } from './client.js';
import { firstTextBlock } from './result-decoder.js';

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

function isBuiltInName(name: string): name is 'echo' | 'time' {
  return name === 'echo' || name === 'time';
}

async function main(): Promise<void> {
  const [domain, action, name] = process.argv.slice(2);

  if (domain !== 'tools' || !action) {
    process.stderr.write(
      'Usage: mcp-client tools list [--full] | call <name> --transport <stdio|http|sse> --endpoint <url-or-command> [--json <payload>] [--protocolVersion <version>]\n'
    );
    process.exit(1);
  }

  const transport = getTransport();
  const endpoint = getArg('endpoint');
  const payload = getArg('json');
  const protocolVersion = getArg('protocolVersion');
  const full = process.argv.includes('--full');

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
    endpoint: computedEndpoint,
    ...(protocolVersion ? { protocolVersion } : {})
  });

  try {
    if (action === 'list') {
      if (full) {
        const tools = await client.discoverTools();
        process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
        return;
      }
      const tools = await client.listTools();
      process.stdout.write(`${JSON.stringify({ tools }, null, 2)}\n`);
      return;
    }

    if (action === 'call') {
      if (!name) {
        throw new Error('tool name is required for call action');
      }
      const parsedInput: unknown = payload ? JSON.parse(payload) : {};

      let output: unknown;
      if (isBuiltInName(name) && isJsonObject(parsedInput)) {
        // Built-in demo tools keep the legacy typed call path.
        output = await client.callTool(name, parsedInput as never);
      } else {
        if (!isJsonObject(parsedInput)) {
          throw new Error('tool input must be a JSON object');
        }
        const result = await client.callToolResult(name, parsedInput, undefined);
        if (result.isError) {
          const text = firstTextBlock(result);
          throw new Error(text ?? JSON.stringify(result.structuredContent ?? 'tool call failed'));
        }
        output =
          result.structuredContent !== undefined
            ? result.structuredContent
            : decodeContentPayload(result);
      }
      process.stdout.write(`${JSON.stringify({ output }, null, 2)}\n`);
      return;
    }

    throw new Error(`Unsupported action: ${action}`);
  } finally {
    await client.close();
  }
}

function decodeContentPayload(result: NativeToolResult): unknown {
  const textBlock = result.content.find((block) => block.type === 'text');
  const text = typeof textBlock?.text === 'string' ? textBlock.text : undefined;
  if (text === undefined) {
    return { content: result.content };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
