import { jsonValueSchema, type JsonObject, type JsonValue } from './types.js';

export { jsonValueSchema };

/**
 * Structural check for values that survive JSON serialization unchanged.
 * Rejects undefined, functions, symbols, bigints and non-finite numbers at
 * any depth; zod's number parser alone would accept NaN/Infinity.
 */
export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value === 'object' && value !== null) {
    if (Array.isArray(value)) {
      return value.every((item) => isJsonValue(item));
    }
    // Plain objects only: class instances (Date, Map, ...) may carry no
    // enumerable keys and must not slip through as `{}`.
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    for (const nested of Object.values(value)) {
      if (!isJsonValue(nested)) {
        return false;
      }
    }
    return true;
  }
  return false;
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  return isJsonValue(value);
}

export function parseJsonValue(value: unknown): JsonValue | undefined {
  if (!isJsonValue(value)) {
    return undefined;
  }
  const parsed = jsonValueSchema.safeParse(value);
  return parsed.success ? (parsed.data as JsonValue) : undefined;
}

export function parseJsonObject(value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new TypeError('Value is not a JSON object');
  }
  return value;
}
