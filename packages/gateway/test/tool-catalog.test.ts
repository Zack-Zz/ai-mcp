import { describe, expect, it } from 'vitest';
import type { ToolDescriptor } from '@ai-mcp/shared';
import { CatalogError, buildCatalogEntries, type CatalogBuildInput } from '../src/tool-catalog.js';

function tool(name: string, extra: Partial<ToolDescriptor> = {}): ToolDescriptor {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
    ...extra
  };
}

function buildInput(
  backends: Array<{
    id: string;
    tools: ToolDescriptor[];
    resultContract?: 'native-json/v1' | 'standard/v1';
  }>,
  options: CatalogBuildInput['options'] = {}
): CatalogBuildInput {
  return {
    backends: backends.map((backend) => ({
      id: backend.id,
      resultContract: backend.resultContract,
      tools: backend.tools
    })),
    options
  };
}

describe('tool catalog', () => {
  it('builds namespaced entries preserving schemas and metadata', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'catalog',
          resultContract: 'native-json/v1',
          tools: [
            tool('lookup', {
              title: 'Lookup',
              annotations: { readOnlyHint: true },
              _meta: { source: 'erp' },
              outputSchema: { type: 'object', properties: { sku: { type: 'string' } } }
            })
          ]
        },
        {
          id: 'orders',
          resultContract: 'native-json/v1',
          tools: [tool('create', { outputSchema: { type: 'object' } })]
        }
      ])
    );

    const lookup = catalog.entries.find((entry) => entry.publicName === 'catalog__lookup');
    expect(lookup).toBeDefined();
    expect(lookup?.source.inputSchema).toMatchObject({ type: 'object' });
    expect(lookup?.source.annotations).toEqual({ readOnlyHint: true });
    expect(lookup?.source.title).toBe('Lookup');
    expect(lookup?.source._meta).toEqual({ source: 'erp' });
    expect(lookup?.contract).toBe('native-json/v1');

    // The advertised input schema is the downstream one, not a passthrough
    // empty object.
    const advertisedInput = lookup?.advertised.inputSchema as Record<string, unknown>;
    expect(advertisedInput.properties).toBeDefined();

    // The advertised output schema describes the wrapped standard envelope.
    const advertisedOutput = lookup?.advertised.outputSchema as Record<string, unknown>;
    expect(advertisedOutput.required).toEqual(['ok', 'code', 'message']);
    const properties = advertisedOutput.properties as Record<string, unknown>;
    expect(properties.ok).toBeDefined();
    expect(properties.structuredContent).toBeDefined();

    expect(catalog.entries.map((entry) => entry.publicName).sort()).toEqual([
      'catalog__lookup',
      'orders__create'
    ]);
  });

  it('publishes downstream input schemas that reject missing fields', () => {
    const catalog = buildCatalogEntries(buildInput([{ id: 'a', tools: [tool('search')] }]));
    const entry = catalog.entries[0];
    expect(entry).toBeDefined();
    const invalid = entry!.inputValidator.validate({});
    expect(invalid.valid).toBe(false);
    const valid = entry!.inputValidator.validate({ q: 'x' });
    expect(valid.valid).toBe(true);
  });

  it('produces a public output schema that validates real wrapped results', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'a',
          resultContract: 'native-json/v1',
          tools: [
            tool('lookup', {
              outputSchema: {
                type: 'object',
                properties: { sku: { type: 'string' } },
                required: ['sku'],
                additionalProperties: false
              }
            })
          ]
        }
      ])
    );
    const entry = catalog.entries[0]!;
    const good = entry.publicOutputValidator.validate({
      ok: true,
      code: 'OK',
      message: 'Tool call succeeded',
      structuredContent: { sku: 'sku-9' }
    });
    expect(good.valid).toBe(true);

    const badPayload = entry.publicOutputValidator.validate({
      ok: true,
      code: 'OK',
      message: 'Tool call succeeded',
      structuredContent: { sku: 42 }
    });
    expect(badPayload.valid).toBe(false);

    const missingPayload = entry.publicOutputValidator.validate({
      ok: true,
      code: 'OK',
      message: 'Tool call succeeded'
    });
    expect(missingPayload.valid).toBe(false);
  });

  it('keeps $defs scope inside the wrapped payload schema', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'a',
          resultContract: 'native-json/v1',
          tools: [
            tool('nested', {
              outputSchema: {
                type: 'object',
                properties: { item: { $ref: '#/$defs/item' } },
                required: ['item'],
                $defs: {
                  item: {
                    type: 'object',
                    properties: { id: { type: 'number' } },
                    required: ['id'],
                    additionalProperties: false
                  }
                }
              }
            })
          ]
        }
      ])
    );
    const entry = catalog.entries[0]!;
    const good = entry.publicOutputValidator.validate({
      ok: true,
      code: 'OK',
      message: 'ok',
      structuredContent: { item: { id: 1 } }
    });
    expect(good.valid).toBe(true);
    const bad = entry.publicOutputValidator.validate({
      ok: true,
      code: 'OK',
      message: 'ok',
      structuredContent: { item: { id: 'nope' } }
    });
    expect(bad.valid).toBe(false);
  });

  it('fails on duplicate backend ids and duplicate public names', () => {
    expect(() =>
      buildCatalogEntries(
        buildInput([
          { id: 'same', tools: [tool('a')] },
          { id: 'same', tools: [tool('b')] }
        ])
      )
    ).toThrowError(CatalogError);
  });

  it('fails with RESULT_CONTRACT_AMBIGUOUS for unknown schemas under legacy-auto', () => {
    try {
      buildCatalogEntries(
        buildInput([
          {
            id: 'a',
            tools: [
              tool('custom', {
                outputSchema: { type: 'object', properties: { magic: { type: 'number' } } }
              })
            ]
          }
        ])
      );
      throw new Error('expected catalog failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).code).toBe('RESULT_CONTRACT_AMBIGUOUS');
    }
  });

  it('resolves ambiguity through explicit tool overrides', () => {
    const catalog = buildCatalogEntries(
      buildInput(
        [
          {
            id: 'a',
            tools: [
              tool('custom', {
                outputSchema: { type: 'object', properties: { magic: { type: 'number' } } }
              })
            ]
          }
        ],
        { toolOverrides: { a__custom: 'native-json/v1' } }
      )
    );
    expect(catalog.entries[0]?.contract).toBe('native-json/v1');
  });

  it('keeps the registered echo/time legacy compat modes working', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'local',
          tools: [
            tool('echo', {
              outputSchema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text']
              }
            })
          ]
        }
      ])
    );
    expect(catalog.entries[0]?.contract).toBe('native-json/v1');
  });

  it('applies backend-level contract declarations over descriptor defaults', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'a',
          resultContract: 'standard/v1',
          tools: [tool('std')]
        }
      ])
    );
    expect(catalog.entries[0]?.contract).toBe('standard/v1');
  });

  it('lets the backend contract win when the descriptor also declares one', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'a',
          resultContract: 'native-json/v1',
          tools: [
            tool('declared', {
              _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
            })
          ]
        }
      ])
    );
    // Design order: tool override > backend.resultContract > descriptor.
    expect(catalog.entries[0]?.contract).toBe('native-json/v1');
    // Upstream receives a standard envelope; the effective downstream
    // contract is preserved separately in source metadata.
    expect(catalog.entries[0]?.advertised._meta?.['org.ai-mcp/result-contract']).toBe(
      'standard/v1'
    );
    expect(catalog.entries[0]?.advertised._meta?.['org.ai-mcp/downstream-tool']).toMatchObject({
      resultContract: 'native-json/v1'
    });
  });

  it('publishes envelope-shaped output schemas for standard/v1 tools', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'a',
          resultContract: 'standard/v1',
          tools: [
            tool('report', {
              outputSchema: {
                type: 'object',
                properties: {
                  ok: { type: 'boolean' },
                  code: { type: 'string' },
                  message: { type: 'string' },
                  structuredContent: {
                    type: 'object',
                    properties: { done: { type: 'boolean' } },
                    required: ['done'],
                    additionalProperties: false
                  }
                },
                required: ['ok', 'code', 'message'],
                additionalProperties: false
              }
            })
          ]
        }
      ])
    );
    const entry = catalog.entries[0]!;
    // The public schema describes the OUTER standard envelope, never the
    // bare downstream payload schema.
    const output = entry.advertised.outputSchema as Record<string, unknown>;
    expect(output.required).toEqual(['ok', 'code', 'message']);
    expect((output.properties as Record<string, unknown>).ok).toBeDefined();

    const good = entry.publicOutputValidator.validate({
      ok: true,
      code: 'OK',
      message: 'done',
      structuredContent: { done: true }
    });
    expect(good.valid).toBe(true);
    const badPayload = entry.publicOutputValidator.validate({
      ok: true,
      code: 'OK',
      message: 'done',
      structuredContent: { done: 'yes' }
    });
    expect(badPayload.valid).toBe(false);
  });

  it('rejects taskSupport=required tools with UNSUPPORTED_CAPABILITY', () => {
    try {
      buildCatalogEntries(
        buildInput([
          {
            id: 'a',
            tools: [tool('tasky', { execution: { taskSupport: 'required' } })]
          }
        ])
      );
      throw new Error('expected catalog failure');
    } catch (error) {
      expect(error).toBeInstanceOf(CatalogError);
      expect((error as CatalogError).code).toBe('UNSUPPORTED_CAPABILITY');
    }
  });

  it('marks optional task support as forbidden in the advertised view', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'a',
          tools: [tool('tasky', { execution: { taskSupport: 'optional' } })]
        }
      ])
    );
    expect(catalog.entries[0]?.advertised.execution).toEqual({ taskSupport: 'forbidden' });
    expect(catalog.entries[0]?.source.execution).toEqual({ taskSupport: 'optional' });
  });

  it('honors descriptor-declared result contracts via _meta', () => {
    const catalog = buildCatalogEntries(
      buildInput([
        {
          id: 'a',
          tools: [
            tool('declared', {
              _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
            })
          ]
        }
      ])
    );
    expect(catalog.entries[0]?.contract).toBe('standard/v1');
  });

  it('shares one snapshot revision across entries', () => {
    const catalog = buildCatalogEntries(
      buildInput([{ id: 'a', tools: [tool('one'), tool('two')] }])
    );
    expect(new Set(catalog.entries.map((entry) => entry.snapshotRevision)).size).toBe(1);
  });
});
