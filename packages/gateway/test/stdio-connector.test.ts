import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { StandardToolResult } from '@ai-mcp/shared';
import { StdioConnector } from '../src/connectors/stdio.js';

const fixture = fileURLToPath(new URL('./fixtures/stdio-echo-server.mjs', import.meta.url));

describe('StdioConnector against a real child process', () => {
  it('discovers, calls and closes a real stdio downstream', async () => {
    const connector = new StdioConnector({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 8000
    });

    const tools = await connector.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo']);
    const inputSchema = tools[0]?.descriptor.inputSchema as Record<string, unknown>;
    expect(inputSchema.properties).toBeDefined();

    const result = await connector.callTool('echo', { q: 'real-stdio' });
    expect(result.native.isError).toBe(false);
    expect(result.native.structuredContent).toEqual({ q: 'real-stdio' });
    expect((result.output as StandardToolResult).ok).toBe(true);

    await connector.close();
    await connector.close();
  }, 20_000);

  it('reports invalid arguments before spawning a call', async () => {
    const connector = new StdioConnector({
      command: process.execPath,
      args: [fixture],
      timeoutMs: 8000
    });
    await expect(connector.callTool('echo', 'not-an-object')).rejects.toMatchObject({
      category: 'invalid_request'
    });
    await connector.close();
  }, 20_000);
});
