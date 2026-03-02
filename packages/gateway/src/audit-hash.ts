import { createHmac } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of entries) {
      normalized[key] = canonicalize(item);
    }
    return normalized;
  }

  return value;
}

export function hashInputPayload(payload: unknown, secret: string): string {
  const canonical = JSON.stringify(canonicalize(payload));
  return createHmac('sha256', secret).update(canonical).digest('hex');
}
