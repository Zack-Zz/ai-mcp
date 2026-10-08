import { describe, expect, it } from 'vitest';
import type { NativeToolResult, ToolDescriptor } from '@ai-mcp/shared';
import { adaptDownstreamResult } from '../src/result-adapter.js';
import type { CatalogEntry } from '../src/tool-catalog.js';

function descriptor(outputSchema?: ToolDescriptor['outputSchema']): ToolDescriptor {
  return {
    name: 'catalog.lookup',
    description: 'lookup',
    inputSchema: { type: 'object' },
    ...(outputSchema !== undefined ? { outputSchema } : {})
  };
}

function entry(
  contract: 'native-json/v1' | 'standard/v1' | 'legacy-auto',
  withOutputValidator = true
): CatalogEntry {
  return {
    contract,
    publicName: 'local__catalog_lookup',
    backendId: 'local',
    backendToolName: 'catalog.lookup',
    source: descriptor({
      type: 'object',
      properties: { sku: { type: 'string' } },
      required: ['sku'],
      additionalProperties: false
    }),
    advertised: descriptor(),
    inputValidator: { dialect: '2020-12', fingerprint: 'x', validate: () => ({ valid: true }) },
    ...(withOutputValidator
      ? {
          sourceOutputValidator: {
            dialect: '2020-12' as const,
            fingerprint: 'y',
            validate: (value: unknown) => {
              const ok =
                typeof value === 'object' &&
                value !== null &&
                'sku' in value &&
                typeof (value as { sku?: unknown }).sku === 'string' &&
                !('extra' in value);
              return ok
                ? { valid: true }
                : {
                    valid: false,
                    issues: [{ path: '/sku', keyword: 'type', message: 'must be sku string' }]
                  };
            }
          }
        }
      : {}),
    publicOutputValidator: {
      dialect: '2020-12',
      fingerprint: 'z',
      validate: () => ({ valid: true })
    },
    snapshotRevision: 'rev-1'
  } as CatalogEntry;
}

function nativeResult(parts: Partial<NativeToolResult>): NativeToolResult {
  return {
    content: [],
    isError: false,
    ...parts
  };
}

describe('adaptDownstreamResult', () => {
  it('wraps native success payloads into the standard envelope', () => {
    const adapted = adaptDownstreamResult(
      nativeResult({ structuredContent: { sku: 'sku-1' } }),
      entry('native-json/v1')
    );
    expect(adapted.kind).toBe('success');
    if (adapted.kind !== 'success') {
      return;
    }
    expect(adapted.standard.ok).toBe(true);
    expect(adapted.standard.code).toBe('OK');
    expect(adapted.standard.structuredContent).toEqual({ sku: 'sku-1' });
  });

  it('rejects native success payloads that violate the source output schema', () => {
    const adapted = adaptDownstreamResult(
      nativeResult({ structuredContent: { sku: 7 } }),
      entry('native-json/v1')
    );
    expect(adapted.kind).toBe('failure');
    if (adapted.kind === 'failure') {
      expect(adapted.fault.category).toBe('invalid_result');
    }
  });

  it('reports invalid_result when a declared schema gets no structured content', () => {
    const adapted = adaptDownstreamResult(
      nativeResult({ content: [{ type: 'text', text: 'plain' }] }),
      entry('native-json/v1')
    );
    expect(adapted.kind).toBe('failure');
    if (adapted.kind === 'failure') {
      expect(adapted.fault.category).toBe('invalid_result');
    }
  });

  it('keeps business payload ok:false as success data (no unwrap, no failure)', () => {
    const adapted = adaptDownstreamResult(
      nativeResult({ structuredContent: { sku: 'sku-1', ok: false } }),
      entry('native-json/v1')
    );
    expect(adapted.kind).toBe('success');
    if (adapted.kind === 'success') {
      expect(adapted.standard.ok).toBe(true);
      expect(adapted.standard.structuredContent).toEqual({ sku: 'sku-1', ok: false });
    }
  });

  it('keeps a successful query of a failed business task a success', () => {
    const failedTaskEntry = entry('native-json/v1', false);
    const adapted = adaptDownstreamResult(
      nativeResult({ structuredContent: { task: { state: 'failed' } } }),
      failedTaskEntry
    );
    expect(adapted.kind).toBe('success');
  });

  it('turns native isError results into tool failures with diagnostics', () => {
    const adapted = adaptDownstreamResult(
      nativeResult({
        content: [{ type: 'text', text: 'downstream exploded' }],
        structuredContent: { reason: 'out_of_stock' },
        isError: true
      }),
      entry('native-json/v1')
    );
    expect(adapted.kind).toBe('tool_failure');
    if (adapted.kind === 'tool_failure') {
      expect(adapted.standard.ok).toBe(false);
      expect(adapted.standard.message).toContain('downstream exploded');
      expect(adapted.standard.structuredContent).toEqual({ reason: 'out_of_stock' });
      expect(adapted.fault.category).toBe('tool_failure');
    }
  });

  it('turns standard ok:false into a tool failure without double wrapping', () => {
    const standardEntryNoValidator = entry('standard/v1', false);
    const adapted = adaptDownstreamResult(
      nativeResult({
        structuredContent: { ok: false, code: 'REJECTED', message: 'quota exceeded' }
      }),
      standardEntryNoValidator
    );
    expect(adapted.kind).toBe('tool_failure');
    if (adapted.kind === 'tool_failure') {
      expect(adapted.standard.ok).toBe(false);
      expect(adapted.standard.code).toBe('REJECTED');
    }
  });

  it('passes standard ok:true through without re-wrapping', () => {
    const standardEntryNoValidator = entry('standard/v1', false);
    const adapted = adaptDownstreamResult(
      nativeResult({
        structuredContent: {
          ok: true,
          code: 'OK',
          message: 'done',
          structuredContent: { sku: 'sku-2' }
        }
      }),
      standardEntryNoValidator
    );
    expect(adapted.kind).toBe('success');
    if (adapted.kind === 'success') {
      expect(adapted.standard.structuredContent).toEqual({ sku: 'sku-2' });
      expect(adapted.standard.code).toBe('OK');
    }
  });

  it('reports invalid_result when a standard ok:true envelope lacks structured content', () => {
    const withSchema = entry('standard/v1');
    const adapted = adaptDownstreamResult(
      nativeResult({
        structuredContent: { ok: true, code: 'OK', message: 'no payload' }
      }),
      withSchema
    );
    expect(adapted.kind).toBe('failure');
    if (adapted.kind === 'failure') {
      expect(adapted.fault.category).toBe('invalid_result');
    }
  });

  it('reports invalid_result for a malformed standard envelope', () => {
    const standardEntryNoValidator = entry('standard/v1', false);
    const adapted = adaptDownstreamResult(
      nativeResult({ structuredContent: { ok: 'yes', code: 'X', message: 'm' } }),
      standardEntryNoValidator
    );
    expect(adapted.kind).toBe('failure');
    if (adapted.kind === 'failure') {
      expect(adapted.fault.category).toBe('invalid_result');
    }
  });

  it('keeps native failure priority when standard ok:true conflicts', () => {
    const standardEntryNoValidator = entry('standard/v1', false);
    const adapted = adaptDownstreamResult(
      nativeResult({
        structuredContent: { ok: true, code: 'OK', message: 'claims success' },
        isError: true
      }),
      standardEntryNoValidator
    );
    expect(adapted.kind).toBe('tool_failure');
  });

  it('recognizes full standard envelopes under legacy-auto without a schema', () => {
    const legacyEntry = entry('legacy-auto', false);
    const adapted = adaptDownstreamResult(
      nativeResult({
        structuredContent: { ok: false, code: 'LEGACY_FAIL', message: 'legacy path' }
      }),
      legacyEntry
    );
    expect(adapted.kind).toBe('tool_failure');
  });

  it('preserves non-text content blocks on the envelope', () => {
    const adapted = adaptDownstreamResult(
      nativeResult({
        content: [
          { type: 'image', data: 'aGk=', mimeType: 'image/png' },
          { type: 'text', text: 'see attachment' }
        ],
        structuredContent: { sku: 'sku-3' }
      }),
      entry('native-json/v1')
    );
    expect(adapted.kind).toBe('success');
    if (adapted.kind === 'success') {
      expect(adapted.standard.content).toHaveLength(2);
      expect(adapted.standard.content?.[0]).toMatchObject({ type: 'image' });
    }
  });
});
