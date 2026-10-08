import { describe, expect, it } from 'vitest';
import type { NativeToolResult, StandardToolResult } from '@ai-mcp/shared';
import { projectStandardResult, toConnectorError } from '../src/connectors/result.js';
import { DownstreamConnectorError } from '../src/connectors/base.js';
import { McpClientError } from '@ai-mcp/mcp-client';

function native(parts: Partial<NativeToolResult>): NativeToolResult {
  return { content: [], isError: false, ...parts };
}

describe('projectStandardResult branches', () => {
  it('recognizes full standard envelopes from legacy downstreams on success', () => {
    const projected = projectStandardResult(
      native({
        structuredContent: { ok: true, code: 'OK', message: 'done', traceId: 't' }
      })
    ) as StandardToolResult;
    expect(projected.code).toBe('OK');
    expect(projected.traceId).toBe('t');
  });

  it('uses plain text as a payload when JSON parsing fails', () => {
    const projected = projectStandardResult(
      native({ content: [{ type: 'text', text: 'plain words' }] })
    ) as StandardToolResult;
    expect(projected.structuredContent).toBe('plain words');
  });

  it('prefers structured message text for native errors without text', () => {
    const projected = projectStandardResult(
      native({ structuredContent: { message: 'from structure' }, isError: true })
    ) as StandardToolResult;
    expect(projected.message).toBe('from structure');
    expect(projected.code).toBe('TOOL_FAILED');
  });

  it('falls back to a generic message when an error has no diagnostics', () => {
    const projected = projectStandardResult(native({ isError: true }));
    expect(projected.message).toBe('Downstream tool call failed');
  });

  it('rejects empty results without structured content or content blocks', () => {
    expect(() => projectStandardResult(native({ content: [] }))).toThrowError(
      DownstreamConnectorError
    );
  });
});

describe('toConnectorError mapping', () => {
  it('preserves connector errors and maps client categories', () => {
    const original = new DownstreamConnectorError('cancelled', 'stop');
    expect(toConnectorError(original)).toBe(original);

    expect(toConnectorError(new McpClientError('rate_limited', 'RATE_LIMITED', 'x')).category).toBe(
      'rate_limited'
    );
    expect(
      toConnectorError(new McpClientError('policy_denied', 'POLICY_DENIED', 'x')).category
    ).toBe('policy_denied');
    expect(toConnectorError(new McpClientError('tool_failure', 'TOOL_FAILED', 'x')).category).toBe(
      'backend_error'
    );
    expect(toConnectorError(new Error('plain')).category).toBe('backend_error');
  });
});
