import { describe, expect, it } from 'vitest';
import type { NativeToolResult } from '@ai-mcp/shared';
import {
  decodeTextJsonFallback,
  describeToolFailure,
  firstTextBlock,
  toNativeToolResult
} from '../src/result-decoder.js';

function native(parts: Partial<NativeToolResult>): NativeToolResult {
  return { content: [], isError: false, ...parts };
}

describe('result decoder branches', () => {
  it('rejects malformed native results', () => {
    expect(() => toNativeToolResult('nope')).toThrowError(/non-object/);
    expect(() => toNativeToolResult({ structuredContent: {} })).toThrowError(/content array/);
    expect(() => toNativeToolResult({ content: ['text'] })).toThrowError(/malformed content/);
    expect(() => toNativeToolResult({ content: [], structuredContent: new Date() })).toThrowError(
      /structuredContent/
    );
  });

  it('keeps _meta only when it is valid json', () => {
    const withMeta = toNativeToolResult({
      content: [],
      isError: false,
      _meta: { hop: 1 }
    });
    expect(withMeta._meta).toEqual({ hop: 1 });

    const withoutMeta = toNativeToolResult({ content: [], isError: false });
    expect(withoutMeta._meta).toBeUndefined();
  });

  it('reads text blocks and falls back to undefined when absent or non-json', () => {
    expect(firstTextBlock(native({ content: [{ type: 'text', text: 'hi' }] }))).toBe('hi');
    expect(firstTextBlock(native({ content: [{ type: 'image', data: 'aGk=' }] }))).toBeUndefined();
    expect(decodeTextJsonFallback(native({ content: [] }))).toBeUndefined();
    // The client-side fallback only decodes JSON text; plain strings are
    // reported as undecodable so callValidatedTool surfaces a clear error.
    expect(decodeTextJsonFallback(native({ content: [{ type: 'text', text: 'no-json' }] }))).toBe(
      undefined
    );
    expect(
      decodeTextJsonFallback(native({ content: [{ type: 'text', text: '{"ok":true}' }] }))
    ).toEqual({ ok: true });
  });

  it('describes failures from structured messages, raw json or defaults', () => {
    expect(
      describeToolFailure(native({ structuredContent: { message: 'boom' }, isError: true }), 't')
    ).toBe('Tool t failed: boom');
    expect(
      describeToolFailure(native({ structuredContent: { reason: 'x' }, isError: true }), 't')
    ).toContain('x');
    expect(describeToolFailure(native({ isError: true }), 't')).toBe('Tool t failed');
  });
});
