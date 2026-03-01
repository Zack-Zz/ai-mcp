import { describe, expect, it } from 'vitest';
import { toolSchemas } from '@ai-mcp/shared';
import { createServer } from '../src/server.js';

describe('mcp server', () => {
  it('lists default tools', async () => {
    const server = createServer();
    const response = await server.handleRawRequest({ id: '1', method: 'tools/list' });
    if (!('result' in response) || !('tools' in response.result)) {
      throw new Error('Expected result');
    }
    expect(response.result.tools.map((item: { name: string }) => item.name).sort()).toEqual([
      'echo',
      'time'
    ]);
  });

  it('lists default resources and prompts', async () => {
    const server = createServer();
    const resourceResponse = await server.handleRawRequest({ id: 'r1', method: 'resources/list' });
    const promptResponse = await server.handleRawRequest({ id: 'p1', method: 'prompts/list' });

    if (!('result' in resourceResponse) || !('resources' in resourceResponse.result)) {
      throw new Error('Expected resource result');
    }
    if (!('result' in promptResponse) || !('prompts' in promptResponse.result)) {
      throw new Error('Expected prompt result');
    }

    expect(resourceResponse.result.resources[0]?.name).toBe('server-info');
    expect(promptResponse.result.prompts[0]?.name).toBe('tool-guide');
  });

  it('calls echo tool', async () => {
    const server = createServer();
    const response = await server.handleRawRequest({
      id: '2',
      method: 'tools/call',
      params: {
        name: 'echo',
        input: { text: 'hello' }
      }
    });

    if (!('result' in response)) {
      throw new Error('Expected result');
    }

    expect(response.result).toEqual({
      output: {
        text: 'hello'
      }
    });
  });

  it('returns error for invalid input', async () => {
    const server = createServer();
    const response = await server.handleRawRequest({
      id: '3',
      method: 'tools/call',
      params: {
        name: 'echo',
        input: { text: '' }
      }
    });

    if (!('error' in response)) {
      throw new Error('Expected error');
    }

    expect(response.error.code).toBe('INVALID_PARAMS');
  });

  it('supports middleware short circuit', async () => {
    const server = createServer();
    server.use(async () => {
      throw new Error('blocked');
    });

    const response = await server.handleRawRequest({ id: '4', method: 'tools/list' });
    if (!('error' in response)) {
      throw new Error('Expected error');
    }
    expect(response.error.code).toBe('INTERNAL');
  });

  it('rejects duplicate tool registration', () => {
    const server = createServer();
    expect(() =>
      server.registerTool({
        name: 'echo',
        description: 'duplicate',
        inputSchema: toolSchemas.echo.input,
        outputSchema: toolSchemas.echo.output,
        handler: () => ({ text: 'a' })
      })
    ).toThrowError('Tool already registered: echo');
  });
});
