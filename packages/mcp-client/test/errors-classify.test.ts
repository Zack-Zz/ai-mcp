import { describe, expect, it } from 'vitest';
import { McpError as SdkMcpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { classifySdkClientError, McpClientError } from '../src/errors.js';

describe('classifySdkClientError branches', () => {
  it('preserves typed fault categories even when the wire uses a generic internal code', () => {
    expect(
      classifySdkClientError(
        new SdkMcpError(-32603, 'bad output', {
          category: 'invalid_result',
          projectCode: 'INVALID_RESULT',
          traceId: 'trace'
        }),
        'request'
      )
    ).toMatchObject({ category: 'invalid_result', projectCode: 'INVALID_RESULT' });
  });
  it('passes through project errors untouched', () => {
    const original = new McpClientError('cancelled', 'CANCELLED', 'stop');
    expect(classifySdkClientError(original, 'request')).toBe(original);
  });

  it('maps gateway numeric codes to categories', () => {
    for (const [code, category] of [
      [-32010, 'rate_limited'],
      [-32020, 'policy_denied'],
      [-32030, 'backend_unavailable'],
      [-32040, 'backend_timeout']
    ] as const) {
      const classified = classifySdkClientError(new SdkMcpError(code, 'x'), 'request');
      expect(classified.category).toBe(category);
    }
  });

  it('marks transport-closed connect errors permanent', () => {
    const classified = classifySdkClientError(
      new SdkMcpError(-32000, 'Connection closed'),
      'connect'
    );
    expect(classified.category).toBe('backend_unavailable');
    expect(classified.permanent).toBe(true);
  });

  it('marks a detached SDK transport permanent so later operations replace it', () => {
    expect(classifySdkClientError(new Error('Not connected'), 'request')).toMatchObject({
      category: 'backend_unavailable',
      permanent: true
    });
  });

  it('keeps unknown JSON-RPC codes as invalid_request', () => {
    const classified = classifySdkClientError(
      new SdkMcpError(-32601, 'Method not found'),
      'request'
    );
    expect(classified.category).toBe('invalid_request');
  });

  it('classifies zod validation failures as invalid_result', () => {
    const parsed = z.object({ a: z.string() }).safeParse({ a: 1 });
    if (parsed.success) {
      throw new Error('expected failure');
    }
    const classified = classifySdkClientError(parsed.error, 'request');
    expect(classified.category).toBe('invalid_result');
  });

  it('separates abort shapes by phase', () => {
    const abortError = Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError'
    });
    expect(classifySdkClientError(abortError, 'request').category).toBe('cancelled');
    expect(classifySdkClientError(abortError, 'connect').category).toBe('backend_timeout');
  });

  it('falls back to message text only for unknown errors', () => {
    expect(
      classifySdkClientError(new Error('connect ECONNREFUSED 127.0.0.1:1'), 'connect').category
    ).toBe('backend_unavailable');
    expect(classifySdkClientError(new Error('request timed out'), 'request').category).toBe(
      'backend_timeout'
    );
    expect(classifySdkClientError(new Error('operation was abort(ed)'), 'request').category).toBe(
      'cancelled'
    );
    expect(classifySdkClientError(new Error('mystery'), 'close').category).toBe('internal');
  });
});
