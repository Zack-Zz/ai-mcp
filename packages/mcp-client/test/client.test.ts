import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../src/client.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('mcp client', () => {
  it('lists tools over http', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        id: 'ok-0',
        result: {
          tools: [{ name: 'echo', description: 'Echo back input' }]
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });

    const tools = await client.listTools();
    expect(tools).toEqual([{ name: 'echo', description: 'Echo back input' }]);
    await client.close();
  });

  it('calls tool over http', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        id: 'ok-1',
        result: {
          output: { text: 'hello' }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });

    const output = await client.callTool('echo', { text: 'hello' });
    expect(output).toEqual({ text: 'hello' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('supports sse transport path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        id: 'ok-sse',
        result: {
          output: { text: 'hello-sse' }
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({
      transport: 'sse',
      endpoint: 'http://localhost:3001/sse/call'
    });
    const output = await client.callTool('echo', { text: 'hello-sse' });
    expect(output).toEqual({ text: 'hello-sse' });
    await client.close();
  });

  it('throws for invalid list response shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        id: 'bad-list',
        result: { output: { text: 'not-tools' } }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });
    await expect(client.listTools()).rejects.toThrowError('Invalid list tools response');
    await client.close();
  });

  it('throws for rpc error payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      json: async () => ({
        id: 'rpc-err',
        error: {
          code: 'INVALID_PARAMS',
          message: 'bad input',
          traceId: 'trace-e1'
        }
      })
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3200/mcp'
    });
    await expect(client.callTool('echo', { text: 'x' })).rejects.toThrowError('bad input');
    await client.close();
  });

  it('handles timeout', async () => {
    const fetchMock = vi.fn((_: string, init?: RequestInit) => {
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('aborted'));
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = createClient({
      transport: 'http',
      endpoint: 'http://localhost:3201/mcp',
      timeoutMs: 20
    });

    await expect(client.listTools()).rejects.toThrowError();
    await client.close();
  });
});
