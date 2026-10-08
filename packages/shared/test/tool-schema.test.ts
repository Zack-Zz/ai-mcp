import { describe, expect, it } from 'vitest';
import { SchemaCompileError, createSchemaCompiler } from '../src/tool-schema.js';

describe('schema compiler dialects', () => {
  it('defaults to 2020-12 and validates values without coercion', () => {
    const compiler = createSchemaCompiler();
    const compiled = compiler.compile({
      type: 'object',
      properties: { port: { type: 'number' }, name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false
    });

    expect(compiled.dialect).toBe('2020-12');
    expect(compiled.validate({ name: 'a', port: 1 }).valid).toBe(true);
    const wrong = compiled.validate({ name: 'a', port: '1' });
    expect(wrong.valid).toBe(false);
    if (!wrong.valid) {
      expect(wrong.issues.length).toBeGreaterThan(0);
      expect(wrong.issues[0]?.keyword).toBeTruthy();
    }
    expect(compiled.validate({ name: 'a', extra: true }).valid).toBe(false);
  });

  it('does not coerce, fill defaults or strip unknown keys', () => {
    const compiler = createSchemaCompiler();
    const document = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: {
        level: { type: 'string', default: 'info' },
        count: { type: 'number' }
      }
    } as Record<string, unknown>;
    const documentClone = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
    const compiled = compiler.compile(document);

    const input = { count: '3', unknown: 'keep' } as Record<string, unknown>;
    const inputClone = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const result = compiled.validate(input);

    expect(result.valid).toBe(false);
    expect(input).toEqual(inputClone);
    expect(document).toEqual(documentClone);
  });

  it('supports explicit draft-07 documents', () => {
    const compiler = createSchemaCompiler();
    const compiled = compiler.compile({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { id: { type: 'integer', minimum: 1 } },
      required: ['id']
    });

    expect(compiled.dialect).toBe('draft-07');
    expect(compiled.validate({ id: 2 }).valid).toBe(true);
    expect(compiled.validate({ id: 0 }).valid).toBe(false);
  });

  it('rejects unsupported dialects before use', () => {
    const compiler = createSchemaCompiler();
    expect(() =>
      compiler.compile({
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        type: 'object'
      })
    ).toThrowError(SchemaCompileError);
    try {
      compiler.compile({ $schema: 'http://json-schema.org/draft-06/schema#', type: 'object' });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaCompileError);
      expect((error as SchemaCompileError).code).toBe('SCHEMA_UNSUPPORTED');
    }
  });

  it('supports local $defs/$ref, enums and oneOf', () => {
    const compiler = createSchemaCompiler();
    const compiled = compiler.compile({
      type: 'object',
      properties: {
        kind: { enum: ['a', 'b'] },
        payload: { oneOf: [{ $ref: '#/$defs/text' }, { $ref: '#/$defs/num' }] }
      },
      required: ['kind', 'payload'],
      $defs: {
        text: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
        num: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }
      }
    });

    expect(compiled.validate({ kind: 'a', payload: { value: 'x' } }).valid).toBe(true);
    expect(compiled.validate({ kind: 'a', payload: { value: true } }).valid).toBe(false);
    expect(compiled.validate({ kind: 'c', payload: { value: 'x' } }).valid).toBe(false);
  });

  it('rejects external references', () => {
    const compiler = createSchemaCompiler();
    expect(() =>
      compiler.compile({
        type: 'object',
        properties: { ref: { $ref: 'https://example.com/schema.json' } }
      })
    ).toThrowError(/external|unsupported/i);
  });

  it('rejects malformed $schema and non-string refs', () => {
    const compiler = createSchemaCompiler();
    expect(() => compiler.compile({ $schema: 42, type: 'object' })).toThrowError(
      SchemaCompileError
    );
    expect(() => compiler.compile({ type: 'object', properties: { x: { $ref: 7 } } })).toThrowError(
      SchemaCompileError
    );
    expect(() =>
      compiler.compile({ type: 'object', properties: { x: { $dynamicRef: 'http://x/#a' } } })
    ).toThrowError(SchemaCompileError);
  });

  it('accepts https draft-07 declarations', () => {
    const compiler = createSchemaCompiler();
    const compiled = compiler.compile({
      $schema: 'https://json-schema.org/draft-07/schema',
      type: 'object'
    });
    expect(compiled.dialect).toBe('draft-07');
  });

  it('caches by content fingerprint across dialects', () => {
    const compiler = createSchemaCompiler();
    const first = compiler.compile({ type: 'object', properties: { a: { type: 'string' } } });
    const second = compiler.compile({ type: 'object', properties: { a: { type: 'string' } } });
    const draft07 = compiler.compile({
      $schema: 'http://json-schema.org/draft-07/schema#',
      type: 'object',
      properties: { a: { type: 'string' } }
    });

    expect(second.fingerprint).toBe(first.fingerprint);
    expect(draft07.fingerprint).not.toBe(first.fingerprint);
  });
});
