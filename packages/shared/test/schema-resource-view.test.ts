import AjvDraft7 from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '../../mcp-client/node_modules/@modelcontextprotocol/sdk/dist/esm/validation/ajv-provider.js';
import { createStandardPassthroughView, createStandardView } from '../src/result-schema.js';
import { SchemaCompiler } from '../src/tool-schema.js';

const success = (structuredContent: unknown) => ({
  ok: true,
  code: 'OK',
  message: 'done',
  structuredContent
});

describe('public schemas preserve accepted dialects and resource scopes', () => {
  it.each([
    ['https://json-schema.org/draft-07/schema#', 'draft-07'],
    ['https://json-schema.org/draft-07/schema', 'draft-07'],
    ['http://json-schema.org/draft-07/schema', 'draft-07'],
    ['https://json-schema.org/draft/2020-12/schema#', '2020-12']
  ] as const)('wraps the accepted %s dialect without losing validation', ($schema, dialect) => {
    const source = {
      $schema,
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
      additionalProperties: false
    };
    const compiler = new SchemaCompiler();
    expect(compiler.compile(source).validate({ value: 'text' }).valid).toBe(true);

    const publicSchema = createStandardView(source);
    const independent =
      dialect === 'draft-07'
        ? new AjvDraft7({ strict: false }).compile(publicSchema)
        : new Ajv2020({ strict: false }).compile(publicSchema);
    expect(independent(success({ value: 'text' }))).toBe(true);
    expect(independent(success({ value: 42 }))).toBe(false);
    expect(compiler.compile(publicSchema).dialect).toBe(dialect);
    expect(source.$schema).toBe($schema);
  });

  it.each(['2020-12', 'draft-07'] as const)(
    'preserves %s nested resource-local refs reached through a root pointer',
    (dialect) => {
      const definitions = dialect === 'draft-07' ? 'definitions' : '$defs';
      const source = {
        $schema:
          dialect === 'draft-07'
            ? 'http://json-schema.org/draft-07/schema#'
            : 'https://json-schema.org/draft/2020-12/schema',
        $id: 'https://example.test/root',
        type: 'object',
        properties: { record: { $ref: `#/${definitions}/record` } },
        required: ['record'],
        additionalProperties: false,
        [definitions]: {
          record: {
            $id: 'https://example.test/record',
            type: 'object',
            properties: {
              value: { $ref: `#/${definitions}/scalar` },
              children: { type: 'array', items: { $ref: '#' } }
            },
            required: ['value'],
            additionalProperties: false,
            [definitions]: { scalar: { type: 'string' } }
          }
        }
      };
      const snapshot = JSON.stringify(source);
      const compiler = new SchemaCompiler();
      const valid = { record: { value: 'parent', children: [{ value: 'child' }] } };
      const invalid = { record: { value: 'parent', children: [{ value: 42 }] } };
      expect(compiler.compile(source).validate(valid).valid).toBe(true);
      expect(compiler.compile(source).validate(invalid).valid).toBe(false);

      const publicSchema = createStandardView(source);
      const independent =
        dialect === 'draft-07'
          ? new AjvDraft7({ strict: false }).compile(publicSchema)
          : new Ajv2020({ strict: false }).compile(publicSchema);
      expect(independent(success(valid))).toBe(true);
      expect(independent(success(invalid))).toBe(false);
      expect(JSON.stringify(source)).toBe(snapshot);
    }
  );

  it('keeps separate root, child and grandchild $id scopes and literal business data', () => {
    const literal = {
      $id: 'https://business.example/id',
      $ref: '#/literal-reference',
      $schema: 'literal-dialect',
      $anchor: 'literal-anchor'
    };
    const source = {
      type: 'object',
      properties: {
        root: { $ref: '#/$defs/scalar' },
        child: {
          $id: 'https://example.test/child',
          type: 'object',
          properties: {
            value: { $ref: '#/$defs/scalar' },
            literal: { const: literal, default: literal, examples: [literal] },
            grandchild: {
              $id: 'grandchild',
              type: 'object',
              properties: { value: { $ref: '#/$defs/scalar' } },
              required: ['value'],
              $defs: { scalar: { type: 'boolean' } }
            }
          },
          required: ['value', 'literal', 'grandchild'],
          $defs: { scalar: { type: 'number' } }
        }
      },
      required: ['root', 'child'],
      $defs: { scalar: { type: 'string' } }
    };
    const good = {
      root: 'root',
      child: { value: 3, literal, grandchild: { value: true } }
    };
    const compiler = new SchemaCompiler();
    expect(compiler.compile(source).validate(good).valid).toBe(true);
    const independent = new Ajv2020({ strict: false }).compile(createStandardView(source));
    expect(independent(success(good))).toBe(true);
    expect(independent(success({ ...good, root: 3 }))).toBe(false);
    expect(
      independent(success({ ...good, child: { ...good.child, value: 'wrong child scope' } }))
    ).toBe(false);
    expect(
      independent(
        success({ ...good, child: { ...good.child, grandchild: { value: 'wrong scope' } } })
      )
    ).toBe(false);
    expect(
      independent(success({ ...good, child: { ...good.child, literal: { $ref: 'changed' } } }))
    ).toBe(false);
  });

  it('preserves a root $ref into a relative-ID resource in a schema array', () => {
    const source = {
      $ref: '#/$defs/records/allOf/0',
      $defs: {
        records: {
          allOf: [
            {
              $id: 'record.json',
              type: 'object',
              properties: { value: { $ref: '#/$defs/scalar' } },
              required: ['value'],
              additionalProperties: false,
              $defs: { scalar: { type: 'integer', minimum: 1 } }
            }
          ]
        }
      }
    };
    const compiler = new SchemaCompiler();
    expect(compiler.compile(source).validate({ value: 1 }).valid).toBe(true);
    expect(compiler.compile(source).validate({ value: 0 }).valid).toBe(false);
    const independent = new Ajv2020({ strict: false }).compile(createStandardView(source));
    expect(independent(success({ value: 1 }))).toBe(true);
    expect(independent(success({ value: 0 }))).toBe(false);
    expect(independent(success({ value: '1' }))).toBe(false);
  });

  it('compiles different wrapped payload resources in one independent validator', () => {
    const ajv = new Ajv2020({ strict: false });
    const strings = ajv.compile(
      createStandardView({
        type: 'object',
        properties: { value: { $ref: '#/$defs/scalar' } },
        required: ['value'],
        $defs: { scalar: { type: 'string' } }
      })
    );
    const numbers = ajv.compile(
      createStandardView({
        type: 'object',
        properties: { value: { $ref: '#/$defs/scalar' } },
        required: ['value'],
        $defs: { scalar: { type: 'number' } }
      })
    );
    expect(strings(success({ value: 'text' }))).toBe(true);
    expect(strings(success({ value: 3 }))).toBe(false);
    expect(numbers(success({ value: 3 }))).toBe(true);
    expect(numbers(success({ value: 'text' }))).toBe(false);
  });

  it('isolates standard schemas with the same source $id in the official SDK validator cache', () => {
    const source = (type: string) => ({
      $id: 'https://peer.test/envelope',
      type: 'object',
      properties: {
        ok: { const: true },
        code: { type: 'string' },
        message: { type: 'string' },
        structuredContent: {
          type: 'object',
          properties: { field: { type } },
          required: ['field'],
          additionalProperties: false
        }
      },
      required: ['ok', 'code', 'message', 'structuredContent'],
      additionalProperties: false
    });
    const stringSource = source('string');
    const numberSource = source('number');
    const snapshot = JSON.stringify([stringSource, numberSource]);
    const provider = new AjvJsonSchemaValidator(new Ajv2020({ strict: false }));
    const strings = provider.getValidator(createStandardPassthroughView(stringSource));
    const numbers = provider.getValidator(createStandardPassthroughView(numberSource));
    expect(strings(success({ field: 'text' })).valid).toBe(true);
    expect(strings(success({ field: 3 })).valid).toBe(false);
    expect(numbers(success({ field: 3 })).valid).toBe(true);
    expect(numbers(success({ field: 'text' })).valid).toBe(false);
    expect(numbers(success({ field: 3, extra: true })).valid).toBe(false);
    expect(numbers(success(success({ field: 3 }))).valid).toBe(false);
    expect(JSON.stringify([stringSource, numberSource])).toBe(snapshot);
  });

  it.each([
    ['https://json-schema.org/draft-07/schema#', 'draft-07'],
    ['https://json-schema.org/draft/2020-12/schema#', '2020-12']
  ] as const)(
    'keeps %s standard body constraints and nested resource scope at the original level',
    ($schema, dialect) => {
      const definitions = dialect === 'draft-07' ? 'definitions' : '$defs';
      const source = {
        $schema,
        $id: 'https://peer.test/envelope',
        type: 'object',
        properties: {
          ok: { const: true },
          code: { type: 'string' },
          message: { type: 'string' },
          structuredContent: { $ref: `#/${definitions}/payload` }
        },
        required: ['ok', 'code', 'message', 'structuredContent'],
        additionalProperties: false,
        [definitions]: {
          payload: {
            $id: 'payload.json',
            type: 'object',
            properties: { field: { $ref: `#/${definitions}/scalar` } },
            required: ['field'],
            additionalProperties: false,
            [definitions]: { scalar: { type: 'number' } }
          }
        }
      };
      const compiler = new SchemaCompiler();
      expect(compiler.compile(source).validate(success({ field: 3 })).valid).toBe(true);
      const view = createStandardPassthroughView(source);
      const independent =
        dialect === 'draft-07'
          ? new AjvDraft7({ strict: false }).compile(view)
          : new Ajv2020({ strict: false }).compile(view);
      expect(independent(success({ field: 3 }))).toBe(true);
      expect(independent(success({ field: 'text' }))).toBe(false);
      expect(independent(success(success({ field: 3 })))).toBe(false);
      expect(independent({ ...success({ field: 3 }), code: 7 })).toBe(false);
      expect(independent({ ...success({ field: 3 }), extra: true })).toBe(false);
      expect(compiler.compile(view).dialect).toBe(dialect);
    }
  );
});
