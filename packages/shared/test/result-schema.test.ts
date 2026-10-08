import { describe, expect, it } from 'vitest';
import { createSchemaCompiler } from '../src/tool-schema.js';
import {
  createStandardView,
  standardToolResultEnvelopeSchema,
  type StandardResultEnvelope
} from '../src/result-schema.js';

const compiler = createSchemaCompiler();

describe('standard tool result wire envelope', () => {
  it('parses a valid success envelope and keeps unknown payload fields', () => {
    const parsed: StandardResultEnvelope = standardToolResultEnvelopeSchema.parse({
      ok: true,
      code: 'OK',
      message: 'Tool call succeeded',
      structuredContent: { text: 'hello' },
      traceId: 'trace-1'
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.structuredContent).toEqual({ text: 'hello' });
  });

  it('rejects envelopes missing required ok/code/message', () => {
    expect(() => standardToolResultEnvelopeSchema.parse({ ok: true })).toThrow();
    expect(() =>
      standardToolResultEnvelopeSchema.parse({ ok: 'true', code: 'OK', message: 'm' })
    ).toThrow();
    expect(() =>
      standardToolResultEnvelopeSchema.parse({ ok: false, code: '', message: 'm' })
    ).toThrow();
  });
});

describe('createStandardView', () => {
  it('wraps a downstream payload schema into an independently validatable public schema', () => {
    const payloadSchema = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    };
    const view = createStandardView(payloadSchema);
    const validator = compiler.compile(view);

    const goodResult = {
      ok: true,
      code: 'OK',
      message: 'Tool call succeeded',
      structuredContent: { text: 'gateway-e2e' },
      traceId: 'trace-2'
    };
    expect(validator.validate(goodResult).valid).toBe(true);

    expect(validator.validate({ ...goodResult, structuredContent: { text: 42 } }).valid).toBe(
      false
    );
    expect(
      validator.validate({ ...goodResult, structuredContent: { text: 'x', extra: 1 } }).valid
    ).toBe(false);
  });

  it('keeps $ref scope pointed at the payload schema, not the envelope root', () => {
    const payloadSchema = {
      type: 'object',
      properties: { item: { $ref: '#/$defs/item' } },
      required: ['item'],
      $defs: {
        item: {
          type: 'object',
          properties: { sku: { type: 'string' } },
          required: ['sku'],
          additionalProperties: false
        }
      }
    } as Record<string, unknown>;
    const view = createStandardView(payloadSchema);
    const validator = compiler.compile(view);

    const good = {
      ok: true,
      code: 'OK',
      message: 'ok',
      structuredContent: { item: { sku: 'sku-1' } }
    };
    expect(validator.validate(good).valid).toBe(true);

    // If $ref was rebased onto the envelope root, this wrong payload would
    // accidentally validate or the compile would fail; require a real rejection.
    const bad = {
      ok: true,
      code: 'OK',
      message: 'ok',
      structuredContent: { item: { sku: 7 } }
    };
    expect(validator.validate(bad).valid).toBe(false);
  });

  it('requires structuredContent only on the success branch of ok', () => {
    const payloadSchema = {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text']
    };
    const view = createStandardView(payloadSchema);
    const validator = compiler.compile(view);

    const failure = {
      ok: false,
      code: 'DOWNSTREAM_REJECTED',
      message: 'rejected'
    };
    expect(validator.validate(failure).valid).toBe(true);
    expect(validator.validate({ ...failure, code: '' }).valid).toBe(false);

    const successWithoutPayload = {
      ok: true,
      code: 'OK',
      message: 'ok'
    };
    expect(validator.validate(successWithoutPayload).valid).toBe(false);
  });

  it('supports draft-07 payload schemas without mixing dialects', () => {
    const payloadSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
      required: ['tags']
    };
    const view = createStandardView(payloadSchema);
    const validator = compiler.compile(view);
    expect(validator.dialect).toBe('draft-07');

    expect(
      validator.validate({
        ok: true,
        code: 'OK',
        message: 'ok',
        structuredContent: { tags: ['a'] }
      }).valid
    ).toBe(true);
    expect(
      validator.validate({
        ok: true,
        code: 'OK',
        message: 'ok',
        structuredContent: { tags: [1] }
      }).valid
    ).toBe(false);
  });

  it('leaves payload unconstrained when no schema is declared', () => {
    const view = createStandardView(undefined);
    const validator = compiler.compile(view);

    expect(
      validator.validate({
        ok: true,
        code: 'OK',
        message: 'ok',
        structuredContent: { anything: [1, 2, { deep: true }] }
      }).valid
    ).toBe(true);
    expect(
      validator.validate({ ok: true, code: 'OK', message: 'ok', structuredContent: 'plain' }).valid
    ).toBe(true);
    expect(validator.validate({ ok: true, code: 'OK', message: 'ok' }).valid).toBe(false);
  });

  it('preserves optional legacy envelope fields on the view', () => {
    const view = createStandardView(undefined);
    const properties = view.properties as Record<string, unknown> | undefined;
    expect(properties?.traceId).toBeDefined();
    expect(properties?.runId).toBeDefined();
    expect(properties?.taskId).toBeDefined();
    expect(properties?.artifacts).toBeDefined();
    expect(properties?.details).toBeDefined();
    expect(properties?.content).toBeDefined();
  });
});
