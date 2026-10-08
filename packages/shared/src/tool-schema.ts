import { mapJsonSchema, supportedSchemaDialect } from './json-schema-walk.js';
import { createHash } from 'node:crypto';
import AjvDraft7 from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { parseJsonObject } from './json.js';
import type { JsonObject } from './types.js';
import { createStandardViewDocument } from './result-schema.js';

export type SchemaDialect = '2020-12' | 'draft-07';

export type ValidationIssue = {
  path: string;
  keyword: string;
  message: string;
};

export type ValidationResult = { valid: true } | { valid: false; issues: ValidationIssue[] };

export type CompiledSchema = {
  dialect: SchemaDialect;
  fingerprint: string;
  validate(value: unknown): ValidationResult;
};

export type SchemaCompileErrorCode = 'SCHEMA_UNSUPPORTED' | 'SCHEMA_INVALID';

export class SchemaCompileError extends Error {
  public constructor(
    public readonly code: SchemaCompileErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'SchemaCompileError';
  }
}

const DIALECT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';
function detectDialect(document: JsonObject): SchemaDialect {
  const declared = document['$schema'];
  if (declared !== undefined && typeof declared !== 'string') {
    throw new SchemaCompileError('SCHEMA_INVALID', '$schema must be a string');
  }
  const dialect = supportedSchemaDialect(declared);
  if (dialect !== undefined) return dialect;
  throw new SchemaCompileError(
    'SCHEMA_UNSUPPORTED',
    `Unsupported JSON Schema dialect: ${String(declared)} (supported: 2020-12 default, draft-07 explicit)`
  );
}

const REF_KEYS = ['$ref', '$dynamicRef'] as const;

function assertNoExternalRefs(document: JsonObject): void {
  mapJsonSchema(document, (schema, path) => {
    if ('$async' in schema)
      throw new SchemaCompileError(
        'SCHEMA_UNSUPPORTED',
        `Async schemas are not supported at ${path}`
      );
    for (const key of REF_KEYS) {
      const value = schema[key];
      if (value !== undefined && (typeof value !== 'string' || !value.startsWith('#'))) {
        throw new SchemaCompileError(
          'SCHEMA_UNSUPPORTED',
          `External schema reference is not supported at ${path}/${key}: ${String(value)}`
        );
      }
    }
    return schema;
  });
}

function canonicalFingerprint(dialect: SchemaDialect, document: JsonObject): string {
  const canonical = JSON.stringify({ dialect, document });
  return createHash('sha256').update(canonical).digest('hex');
}

type AjvError = {
  instancePath?: string;
  keyword?: string;
  message?: string;
  schemaPath?: string;
};

function toIssues(errors: AjvError[] | null | undefined): ValidationIssue[] {
  return (errors ?? []).map((error) => ({
    path: error.instancePath ?? '',
    keyword: error.keyword ?? '',
    message: error.message ?? 'validation failed'
  }));
}

/**
 * Compiles self-contained JSON Schema documents. Local-only references,
 * no coercion, no default filling, no unknown-key stripping: validators
 * observe the payload exactly as sent. Compiled validators are cached by
 * dialect + content fingerprint for the lifetime of the compiler.
 */
export class SchemaCompiler {
  private readonly cache = new Map<string, CompiledSchema>();

  public compile(document: unknown): CompiledSchema {
    let parsed: JsonObject;
    try {
      parsed = parseJsonObject(document);
    } catch {
      throw new SchemaCompileError('SCHEMA_INVALID', 'Schema document must be a JSON object');
    }

    const dialect = detectDialect(parsed);
    assertNoExternalRefs(parsed);
    const fingerprint = canonicalFingerprint(dialect, parsed);
    const cached = this.cache.get(fingerprint);
    if (cached) {
      return cached;
    }

    // Strip a declared $id so two backends using the same $id with different
    // content cannot collide inside one compiler; local refs stay intact.
    // Normalize $schema to the canonical Ajv meta-schema id so recognized
    // spelling variants (https vs http) still compile.
    const canonicalSchemaId =
      dialect === '2020-12' ? DIALECT_2020_12 : 'http://json-schema.org/draft-07/schema#';
    const compileTarget: JsonObject = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key !== '$id')
    );
    if (compileTarget['$schema'] !== undefined) {
      compileTarget['$schema'] = canonicalSchemaId;
    }

    const ajv =
      dialect === '2020-12'
        ? new Ajv2020({ allErrors: true, strict: false })
        : new AjvDraft7({ allErrors: true, strict: false });
    addFormats(ajv as AjvDraft7);

    let validate: ReturnType<AjvDraft7['compile']>;
    try {
      validate = ajv.compile(compileTarget);
    } catch (error) {
      throw new SchemaCompileError(
        'SCHEMA_INVALID',
        `Schema failed to compile: ${error instanceof Error ? error.message : String(error)}`,
        { dialect }
      );
    }

    const compiled: CompiledSchema = {
      dialect,
      fingerprint,
      validate(value: unknown): ValidationResult {
        const valid = validate(value);
        if (valid === true) {
          return { valid: true };
        }
        return {
          valid: false,
          issues: toIssues(validate.errors)
        };
      }
    };
    this.cache.set(fingerprint, compiled);
    return compiled;
  }

  public createStandardView(payload?: unknown): JsonObject {
    return createStandardViewDocument(payload);
  }
}

export function createSchemaCompiler(): SchemaCompiler {
  return new SchemaCompiler();
}
