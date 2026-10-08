import { createHash } from 'node:crypto';
import { mapJsonSchema, supportedSchemaDialect } from './json-schema-walk.js';
import { z } from 'zod';
import { isJsonObject } from './json.js';
import { type JsonObject, type JsonValue, jsonValueSchema, artifactRefSchema } from './types.js';

/**
 * Strict wire envelope for `standard/v1` downstream results. Unlike the
 * legacy `standardToolResultSchema` export (kept for compatibility), payload
 * slots must be actual JSON values.
 */
export const standardToolResultEnvelopeSchema = z
  .object({
    ok: z.boolean(),
    code: z.string().min(1),
    message: z.string(),
    structuredContent: jsonValueSchema.optional(),
    content: z.array(z.record(z.string(), jsonValueSchema)).optional(),
    artifacts: z.array(artifactRefSchema).optional(),
    traceId: z.string().optional(),
    runId: z.string().optional(),
    taskId: z.string().optional(),
    details: z.record(z.string(), jsonValueSchema).optional()
  })
  .strict();

export type StandardResultEnvelope<T = unknown> = Omit<
  z.infer<typeof standardToolResultEnvelopeSchema>,
  'structuredContent'
> & {
  structuredContent?: T;
};

const UNRELOCATABLE_KEYWORDS = ['$anchor', '$dynamicAnchor', '$dynamicRef', '$recursiveRef'];

function isolateSchemaResource(document: JsonObject, kind: 'payload' | 'standard'): JsonObject {
  const cloned = mapJsonSchema(document, (schema, path) => {
    if (kind === 'payload')
      for (const key of UNRELOCATABLE_KEYWORDS) {
        if (key in schema)
          throw new Error(
            `Cannot wrap payload schema: "${key}" at ${path} cannot be relocated; restructure the schema with $defs/$ref`
          );
      }
    return schema;
  });
  // Give S its own resource root so fragment references keep their original
  // scope, including references inside nested $id resources. A content-derived
  // ID avoids clashes when a consumer compiles several public tool schemas in
  // one validator. These IDs identify locally supplied schemas; no external
  // schema is fetched.
  const fingerprint = createHash('sha256').update(JSON.stringify(cloned)).digest('hex');
  return {
    ...cloned,
    $id: `https://schemas.ai-mcp.invalid/${kind}/${fingerprint}`,
    // Ajv eagerly dereferences an embedded resource consisting only of $ref,
    // then resolves that resource's fragment by dereferencing the root again.
    // A neutral applicator keeps the resource root intact without changing
    // which payloads are accepted by any conforming validator.
    ...(cloned['$ref'] !== undefined && cloned['allOf'] === undefined ? { allOf: [true] } : {})
  };
}

const DRAFT_07_SCHEMA_ID = 'http://json-schema.org/draft-07/schema#';

/**
 * Publishes an already-standard result schema at its original body level.
 * An SDK validator caches schemas by root $id, so downstream IDs cannot be
 * reused verbatim across independent backends. Content-derived resource IDs
 * isolate these documents while retaining every body constraint and local
 * reference scope. No result envelope or payload layer is added.
 */
export function createStandardPassthroughView(source: JsonObject): JsonObject {
  if (!isJsonObject(source)) throw new TypeError('Standard schema must be a JSON object');
  const declared = source['$schema'];
  if (declared !== undefined && typeof declared !== 'string')
    throw new TypeError('Standard $schema must be a string');
  const dialect = supportedSchemaDialect(declared);
  if (dialect === undefined) throw new Error(`Unsupported standard dialect: ${declared}`);
  const stripped = Object.fromEntries(
    Object.entries(source).filter(([key]) => key !== '$id' && key !== '$schema')
  );
  return isolateSchemaResource(
    {
      ...stripped,
      $schema:
        dialect === 'draft-07' ? DRAFT_07_SCHEMA_ID : 'https://json-schema.org/draft/2020-12/schema'
    },
    'standard'
  );
}

/**
 * Builds the public output schema W(S) describing the actual wrapped
 * StandardToolResult the gateway returns. The downstream payload schema S is
 * embedded under a namespaced definition as a separate schema resource, so
 * fragment references keep pointing at the correct S or nested $id resource
 * instead of the envelope root. The returned document is independently
 * compilable in the same dialect as S.
 */
export function createStandardViewDocument(payload?: unknown): JsonObject {
  let dialect: '2020-12' | 'draft-07' = '2020-12';
  let embedded: JsonObject | true = true;

  if (payload !== undefined) {
    if (!isJsonObject(payload)) {
      throw new TypeError('Payload schema must be a JSON object');
    }
    const declared = payload['$schema'];
    if (declared !== undefined && typeof declared !== 'string')
      throw new TypeError('Payload $schema must be a string');
    const detected = supportedSchemaDialect(declared);
    if (detected === undefined) throw new Error(`Unsupported payload dialect: ${declared}`);
    dialect = detected;
    const stripped = Object.fromEntries(
      Object.entries(payload).filter(([key]) => key !== '$id' && key !== '$schema')
    );
    embedded = isolateSchemaResource(stripped, 'payload');
  }

  const defsKey = dialect === 'draft-07' ? 'definitions' : '$defs';
  const payloadRef = `#/${defsKey}/aiMcpPayload`;

  const view: Record<string, unknown> = {
    ...(dialect === 'draft-07' ? { $schema: DRAFT_07_SCHEMA_ID } : {}),
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      code: { type: 'string', minLength: 1 },
      message: { type: 'string' },
      structuredContent: {},
      content: { type: 'array' },
      artifacts: { type: 'array' },
      traceId: { type: 'string' },
      runId: { type: 'string' },
      taskId: { type: 'string' },
      details: { type: 'object' }
    },
    required: ['ok', 'code', 'message'],
    additionalProperties: false,
    [defsKey]: { aiMcpPayload: embedded },
    allOf: [
      {
        if: { properties: { ok: { const: true } }, required: ['ok'] },
        then: {
          ...(payload === undefined
            ? {
                anyOf: [
                  { required: ['structuredContent'] },
                  { required: ['content'], properties: { content: { minItems: 1 } } }
                ]
              }
            : { required: ['structuredContent'] }),
          ...(payload === undefined
            ? {}
            : { properties: { structuredContent: { $ref: payloadRef } } })
        }
      }
    ]
  };
  return view as JsonObject;
}

/** Public alias kept stable for callers; the document builder above is internal. */
export const createStandardView = createStandardViewDocument;

export type { JsonValue };
