import { describe, expect, it } from 'vitest';
import { McpError, normalizeError, rpcRequestSchema, toolSchemas } from '../src/index.js';

describe('shared', () => {
  it('validates rpc request', () => {
    const parsed = rpcRequestSchema.parse({ id: '1', method: 'tools/list' });
    expect(parsed.id).toBe('1');
  });

  it('maps unknown error to internal', () => {
    const result = normalizeError(new Error('boom'), 'trace-1');
    expect(result.code).toBe('INTERNAL');
    expect(result.traceId).toBe('trace-1');
  });

  it('creates explicit mcp error', () => {
    const error = new McpError('INVALID_PARAMS', 'bad params', 'trace-2', { field: 'name' });
    expect(error.toShape()).toEqual({
      code: 'INVALID_PARAMS',
      message: 'bad params',
      traceId: 'trace-2',
      details: { field: 'name' }
    });
  });

  it('validates echo schema', () => {
    const output = toolSchemas.echo.output.parse({ text: 'hello' });
    expect(output.text).toBe('hello');
  });
});
