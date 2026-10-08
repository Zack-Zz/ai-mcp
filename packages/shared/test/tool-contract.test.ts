import { describe, expect, it } from 'vitest';
import {
  CONTEXT_META_KEY,
  RESULT_CONTRACT_META_KEY,
  invokeContextMetaSchema,
  isLegalToolName,
  nativeToolResultSchema,
  resultContractSchema,
  toolDescriptorSchema
} from '../src/tool-contract.js';
import { jsonValueSchema, parseJsonObject, parseJsonValue } from '../src/json.js';

describe('tool name validation', () => {
  it('accepts legal business tool names without enum extension', () => {
    expect(isLegalToolName('catalog.lookup')).toBe(true);
    expect(isLegalToolName('orders_create-v2')).toBe(true);
    expect(isLegalToolName('a')).toBe(true);
    expect(isLegalToolName('A_9.z-Z')).toBe(true);
  });

  it('rejects empty, too long and illegal names', () => {
    expect(isLegalToolName('')).toBe(false);
    expect(isLegalToolName('a'.repeat(129))).toBe(false);
    expect(isLegalToolName('hello world')).toBe(false);
    expect(isLegalToolName('目录')).toBe(false);
    expect(isLegalToolName('tool/name')).toBe(false);
    expect(isLegalToolName('tool:call')).toBe(false);
  });
});

describe('tool descriptor schema', () => {
  const baseDescriptor = {
    name: 'catalog.lookup',
    description: 'Lookup catalog items',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } }
  };

  it('accepts a descriptor and preserves optional metadata fields', () => {
    const parsed = toolDescriptorSchema.parse({
      ...baseDescriptor,
      title: 'Catalog Lookup',
      outputSchema: { type: 'object', properties: { name: { type: 'string' } } },
      annotations: { readOnlyHint: true },
      icons: [{ svg: 'icon' }],
      _meta: { source: 'unit' }
    });
    expect(parsed.name).toBe('catalog.lookup');
    expect(parsed.annotations).toEqual({ readOnlyHint: true });
    expect(parsed._meta).toEqual({ source: 'unit' });
  });

  it('rejects descriptors without a JSON object inputSchema', () => {
    expect(() => toolDescriptorSchema.parse({ ...baseDescriptor, inputSchema: 'echo' })).toThrow();
    expect(() =>
      toolDescriptorSchema.parse({ description: 'missing name', inputSchema: {} })
    ).toThrow();
  });
});

describe('native tool result contract', () => {
  it('keeps isError, content blocks and structured content', () => {
    const parsed = nativeToolResultSchema.parse({
      content: [{ type: 'text', text: 'partial failure' }],
      structuredContent: { code: 'NOT_FOUND' },
      isError: true,
      _meta: { retryable: false }
    });
    expect(parsed.isError).toBe(true);
    expect(parsed.content).toHaveLength(1);
  });

  it('rejects results without isError or with non-json content', () => {
    expect(() => nativeToolResultSchema.parse({ content: [] })).toThrow();
    expect(() => nativeToolResultSchema.parse({ content: ['text'], isError: false })).toThrow();
  });
});

describe('result contract declaration', () => {
  it('parses explicit native and standard contracts', () => {
    expect(resultContractSchema.parse('native-json/v1')).toBe('native-json/v1');
    expect(resultContractSchema.parse('standard/v1')).toBe('standard/v1');
    expect(resultContractSchema.parse('legacy-auto')).toBe('legacy-auto');
    expect(() => resultContractSchema.parse('auto')).toThrow();
  });

  it('exposes the reserved meta keys', () => {
    expect(RESULT_CONTRACT_META_KEY).toBe('org.ai-mcp/result-contract');
    expect(CONTEXT_META_KEY).toBe('org.ai-mcp/context');
  });
});

describe('project json contract', () => {
  it('accepts json values and objects', () => {
    expect(jsonValueSchema.safeParse({ a: [1, 'x', null, true] }).success).toBe(true);
    expect(parseJsonObject({ a: 1 })).toEqual({ a: 1 });
  });

  it('rejects non-json values', () => {
    expect(jsonValueSchema.safeParse(undefined).success).toBe(false);
    expect(jsonValueSchema.safeParse(() => 1).success).toBe(false);
    expect(jsonValueSchema.safeParse(Symbol('x')).success).toBe(false);
    expect(jsonValueSchema.safeParse(BigInt(1)).success).toBe(false);
    expect(parseJsonValue(Number.NaN)).toBeUndefined();
  });

  it('rejects non-object json values for object slots', () => {
    expect(() => parseJsonObject('text')).toThrow();
    expect(() => parseJsonObject([1, 2])).toThrow();
    expect(() => parseJsonObject(null)).toThrow();
  });
});

describe('invocation context meta', () => {
  it('parses trace/run/task context from request _meta', () => {
    const parsed = invokeContextMetaSchema.parse({
      [CONTEXT_META_KEY]: { traceId: 't-1', runId: 'r-1', taskId: 'task-9' }
    });
    expect(parsed[CONTEXT_META_KEY]).toEqual({ traceId: 't-1', runId: 'r-1', taskId: 'task-9' });
  });

  it('rejects unknown or malformed context entries', () => {
    expect(() => invokeContextMetaSchema.parse({ [CONTEXT_META_KEY]: { traceId: 42 } })).toThrow();
    expect(() =>
      invokeContextMetaSchema.parse({ [CONTEXT_META_KEY]: { actor: 'caller' } })
    ).toThrow();
  });
});
