import { describe, expect, it } from 'vitest';
import { hashInputPayload } from '../src/audit-hash.js';

describe('hashInputPayload', () => {
  it('is stable for objects with different key order', () => {
    const a = { z: 1, a: 'x', nested: { b: 2, a: 1 } };
    const b = { a: 'x', nested: { a: 1, b: 2 }, z: 1 };

    const hashA = hashInputPayload(a, 'secret-1');
    const hashB = hashInputPayload(b, 'secret-1');

    expect(hashA).toBe(hashB);
  });

  it('changes when secret changes', () => {
    const payload = { text: 'hello' };

    const hashA = hashInputPayload(payload, 'secret-1');
    const hashB = hashInputPayload(payload, 'secret-2');

    expect(hashA).not.toBe(hashB);
  });
});
