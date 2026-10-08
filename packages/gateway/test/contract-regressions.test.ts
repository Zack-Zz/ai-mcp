import { expect, it } from 'vitest';
import { SchemaCompiler, type JsonObject } from '@ai-mcp/shared';
import { buildCatalogEntries } from '../src/tool-catalog.js';
import { adaptDownstreamResult } from '../src/result-adapter.js';

const schema: JsonObject = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, code: { type: 'string' }, message: { type: 'string' } },
  required: ['ok', 'code', 'message'],
  additionalProperties: false
};
function catalog(contract: 'standard/v1' | 'native-json/v1', outputSchema?: JsonObject) {
  const entry = buildCatalogEntries({
    backends: [
      {
        id: 'b',
        resultContract: contract,
        tools: [
          {
            name: 'probe',
            inputSchema: { type: 'object' },
            ...(outputSchema ? { outputSchema } : {})
          }
        ]
      }
    ]
  }).entries[0];
  if (!entry) throw new Error('missing entry');
  return entry;
}
it('validates and advertises the whole standard envelope without requiring an inner payload', () => {
  const entry = catalog('standard/v1', schema);
  const result = adaptDownstreamResult(
    { content: [], structuredContent: { ok: true, code: 'OK', message: 'done' }, isError: false },
    entry,
    { traceId: 't', invocationId: 'i' }
  );
  expect(result.kind).toBe('success');
  if (result.kind !== 'success') throw new Error('expected success');
  expect(result.standard).toEqual({ ok: true, code: 'OK', message: 'done' });
  expect(
    new SchemaCompiler().compile(entry.advertised.outputSchema).validate(result.standard).valid
  ).toBe(true);
});
it('preserves a native standard failure code and artifacts without wrapping it again', () => {
  const entry = catalog('standard/v1');
  const payload = {
    ok: false,
    code: 'BUSINESS_DENIED',
    message: 'denied',
    artifacts: [{ uri: 'file:///diagnostic.json', mimeType: 'application/json' }]
  };
  const result = adaptDownstreamResult(
    { content: [], structuredContent: payload, isError: true },
    entry
  );
  expect(result.kind).toBe('tool_failure');
  if (result.kind !== 'tool_failure') throw new Error('expected failure');
  expect(result.standard.code).toBe('BUSINESS_DENIED');
  expect(result.standard.artifacts).toEqual(payload.artifacts);
  expect(result.standard.structuredContent).toBeUndefined();
});
it('accepts meaningful media-only results and advertises their actual envelope', () => {
  const entry = catalog('native-json/v1');
  const content = [{ type: 'image', data: 'aGk=', mimeType: 'image/png' }];
  const result = adaptDownstreamResult({ content, isError: false }, entry);
  expect(result.kind).toBe('success');
  if (result.kind !== 'success') throw new Error('expected success');
  expect(result.standard.content).toEqual(content);
  expect(
    new SchemaCompiler().compile(entry.advertised.outputSchema).validate(result.standard).valid
  ).toBe(true);
});
