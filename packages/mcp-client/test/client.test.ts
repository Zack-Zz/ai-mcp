import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
  listTools: vi.fn<() => Promise<{ tools: { name: string; description?: string }[] }>>(
    async () => ({
      tools: []
    })
  ),
  callTool: vi.fn<() => Promise<unknown>>(async () => ({ content: [], structuredContent: {} })),
  streamableCtorArg: undefined as URL | undefined,
  sseCtorArg: undefined as URL | undefined,
  stdioCtorArg: undefined as { command: string; args?: string[] | undefined } | undefined
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    public async connect(): Promise<void> {
      await mocks.connect();
    }

    public async close(): Promise<void> {
      await mocks.close();
    }

    public async listTools(): Promise<{ tools: { name: string; description?: string }[] }> {
      return await mocks.listTools();
    }

    public async callTool(): Promise<unknown> {
      return await mocks.callTool();
    }
  }
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {
    public constructor(url: URL) {
      mocks.streamableCtorArg = url;
    }
  }
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: class {
    public constructor(url: URL) {
      mocks.sseCtorArg = url;
    }
  }
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: class {
    public constructor(params: { command: string; args?: string[] }) {
      mocks.stdioCtorArg = params;
    }
  }
}));

afterEach(() => {
  vi.clearAllMocks();
  mocks.streamableCtorArg = undefined;
  mocks.sseCtorArg = undefined;
  mocks.stdioCtorArg = undefined;
});

describe('mcp client', () => {
  it('lists tools over http transport', async () => {
    mocks.listTools.mockResolvedValueOnce({
      tools: [{ name: 'echo', description: 'Echo back input' }]
    });

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });

    const tools = await client.listTools();

    expect(mocks.connect).toHaveBeenCalledTimes(1);
    expect(mocks.streamableCtorArg?.toString()).toBe('http://localhost:3200/mcp');
    expect(tools).toEqual([{ name: 'echo', description: 'Echo back input' }]);
    await client.close();
  });

  it('calls tool and returns structured content', async () => {
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"text":"ignored"}' }],
      structuredContent: { text: 'hello' }
    });

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });

    const output = await client.callTool('echo', { text: 'hello' });
    expect(output).toEqual({ text: 'hello' });
    await client.close();
  });

  it('falls back to text content json when structured content missing', async () => {
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: 'text', text: '{"text":"hello-fallback"}' }]
    });

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });

    const output = await client.callTool('echo', { text: 'hello-fallback' });
    expect(output).toEqual({ text: 'hello-fallback' });
    await client.close();
  });

  it('throws when endpoint missing for http', () => {
    expect(() => createClient({ transport: 'http' })).toThrowError(
      'endpoint is required for http and sse transport'
    );
  });

  it('throws when endpoint missing for stdio', () => {
    expect(() => createClient({ transport: 'stdio' })).toThrowError(
      'endpoint command is required for stdio transport'
    );
  });

  it('normalizes sse endpoint to stream url', () => {
    createClient({
      transport: 'sse',
      endpoint: 'http://localhost:3001/sse/call'
    });

    expect(mocks.sseCtorArg?.toString()).toBe('http://localhost:3001/sse');
  });

  it('parses stdio command with quoted args', () => {
    createClient({
      transport: 'stdio',
      endpoint: 'node "packages/mcp-server/dist/cli.js" --transport stdio'
    });

    expect(mocks.stdioCtorArg).toEqual({
      command: 'node',
      args: ['packages/mcp-server/dist/cli.js', '--transport', 'stdio']
    });
  });

  it('throws for invalid tool response payload', async () => {
    mocks.callTool.mockResolvedValueOnce({
      content: [{ type: 'image', data: 'abc', mimeType: 'image/png' }]
    });

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });

    await expect(client.callTool('echo', { text: 'x' })).rejects.toThrowError(
      'Invalid tool call response'
    );
    await client.close();
  });
});
