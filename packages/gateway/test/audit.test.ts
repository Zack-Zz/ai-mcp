import { describe, expect, it } from 'vitest';
import { InMemoryAuditStore } from '../src/audit.js';

describe('InMemoryAuditStore', () => {
  it('stores audit events in insertion order', async () => {
    const store = new InMemoryAuditStore();

    await store.record({
      timestamp: '2026-03-02T00:00:00.000Z',
      tenantId: 't1',
      action: 'tools/call',
      toolName: 'a__echo',
      traceId: 'trace-1',
      decision: 'allow'
    });

    await store.record({
      timestamp: '2026-03-02T00:00:01.000Z',
      tenantId: 't1',
      action: 'tools/call',
      toolName: 'a__echo',
      traceId: 'trace-2',
      decision: 'deny',
      reason: 'rate limit exceeded'
    });

    const events = store.list();
    expect(events).toHaveLength(2);
    expect(events[0]?.traceId).toBe('trace-1');
    expect(events[1]?.decision).toBe('deny');
  });
});
