import { expect, it } from 'vitest';
import { SchemaCompiler } from '../src/tool-schema.js';

it('rejects async schemas before a Promise can be mistaken for successful validation', () => {
  expect(() => new SchemaCompiler().compile({ $async: true, type: 'object' })).toThrow(/async/i);
});

it('rejects external references nested in schema arrays', () => {
  expect(() =>
    new SchemaCompiler().compile({
      type: 'object',
      allOf: [{ $ref: 'https://example.com/schema' }]
    })
  ).toThrow(/external/i);
});

it('accepts dollar-prefixed business property names and preserves reference-shaped constants when wrapping', () => {
  const compiler = new SchemaCompiler();
  const schema = {
    type: 'object',
    properties: { $async: { type: 'boolean' }, value: { const: { $ref: '#/business-data' } } },
    required: ['$async', 'value'],
    additionalProperties: false
  };
  const payload = { $async: false, value: { $ref: '#/business-data' } };
  expect(compiler.compile(schema).validate(payload).valid).toBe(true);
  expect(
    compiler
      .compile(compiler.createStandardView(schema))
      .validate({ ok: true, code: 'OK', message: 'done', structuredContent: payload }).valid
  ).toBe(true);
});
