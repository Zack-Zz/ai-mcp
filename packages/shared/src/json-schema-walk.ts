import { isJsonObject } from './json.js';
import type { JsonObject, JsonValue } from './types.js';

/** The compiler and public schema builder accept the same dialect spellings. */
export function supportedSchemaDialect(
  declared: string | undefined
): '2020-12' | 'draft-07' | undefined {
  if (declared === undefined) return '2020-12';
  const normalized = declared.endsWith('#') ? declared.slice(0, -1) : declared;
  if (normalized === 'https://json-schema.org/draft/2020-12/schema') return '2020-12';
  if (
    normalized === 'http://json-schema.org/draft-07/schema' ||
    normalized === 'https://json-schema.org/draft-07/schema'
  )
    return 'draft-07';
  return undefined;
}

const MAP_KEYS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies'
]);
const CHILD_KEYS = new Set([
  'items',
  'additionalItems',
  'prefixItems',
  'contains',
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'propertyNames',
  'allOf',
  'anyOf',
  'oneOf',
  'not',
  'if',
  'then',
  'else',
  'contentSchema'
]);

/** Walk schema positions only. const/enum/default/examples contain business JSON. */
export function mapJsonSchema(
  document: JsonObject,
  visit: (schema: JsonObject, path: string) => JsonObject,
  path = ''
): JsonObject {
  const child = (value: JsonValue, childPath: string): JsonValue => {
    if (isJsonObject(value)) return mapJsonSchema(value, visit, childPath);
    if (Array.isArray(value))
      return value.map((item, index) => child(item, `${childPath}/${index}`));
    return value;
  };
  const mapped: JsonObject = {};
  for (const [key, value] of Object.entries(document)) {
    if (MAP_KEYS.has(key) && isJsonObject(value)) {
      mapped[key] = Object.fromEntries(
        Object.entries(value).map(([name, schema]) => [
          name,
          child(schema, `${path}/${key}/${name}`)
        ])
      );
    } else if (CHILD_KEYS.has(key)) {
      mapped[key] = child(value, `${path}/${key}`);
    } else mapped[key] = value;
  }
  return visit(mapped, path);
}
