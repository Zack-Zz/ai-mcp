import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonlAuditStore } from '../src/audit-jsonl.js';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(async (dir) => {
      await rm(dir, { recursive: true, force: true });
    })
  );
});

describe('JsonlAuditStore', () => {
  it('appends one json object per line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-audit-'));
    tempDirs.push(dir);

    const filePath = join(dir, 'audit.log');
    const store = new JsonlAuditStore(filePath);

    await store.record({
      timestamp: '2026-03-02T00:00:00.000Z',
      tenantId: 't1',
      action: 'tools/call',
      toolName: 'local__echo',
      traceId: 'trace-1',
      decision: 'allow'
    });

    await store.record({
      timestamp: '2026-03-02T00:00:01.000Z',
      tenantId: 't1',
      action: 'tools/call',
      toolName: 'local__echo',
      traceId: 'trace-2',
      decision: 'deny',
      downstream: {
        backendId: 'local',
        backendToolName: 'echo'
      },
      durationMs: 24,
      outputSummary: 'TIMEOUT: backend timeout',
      errorCategory: 'backend_timeout',
      reason: 'rate limit exceeded'
    });

    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '{}') as { traceId?: string; decision?: string };
    const second = JSON.parse(lines[1] ?? '{}') as {
      traceId?: string;
      decision?: string;
      outputSummary?: string;
      durationMs?: number;
    };

    expect(first.traceId).toBe('trace-1');
    expect(second.decision).toBe('deny');
    expect(second.outputSummary).toContain('TIMEOUT');
    expect(second.durationMs).toBe(24);
  });

  it('serializes concurrent records into independently parseable lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-audit-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'audit-concurrent.log');
    const store = new JsonlAuditStore(filePath);

    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        store.record({
          timestamp: new Date().toISOString(),
          tenantId: 'concurrent',
          action: 'tools/call',
          toolName: `local__tool_${index}`,
          traceId: `trace-${index}`,
          decision: 'allow'
        })
      )
    );

    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(50);
    const traces = lines.map((line) => (JSON.parse(line) as { traceId: string }).traceId);
    expect(new Set(traces).size).toBe(50);
    await store.close();
  });

  it('flushes queued events on close and surfaces write failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-audit-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'audit-flush.log');
    const store = new JsonlAuditStore(filePath);

    // Queue many events, then immediately close: close must flush them all.
    const records = Array.from({ length: 20 }, (_, index) =>
      store
        .record({
          timestamp: new Date().toISOString(),
          tenantId: 'flush',
          action: 'tools/call',
          toolName: `local__t${index}`,
          traceId: `flush-trace-${index}`,
          decision: 'allow'
        })
        .catch(() => undefined)
    );
    await store.close();
    await Promise.all(records);

    const content = await readFile(filePath, 'utf8');
    expect(content.trim().split('\n')).toHaveLength(20);

    // A record against a closed store fails loudly instead of hanging.
    await expect(
      store.record({
        timestamp: new Date().toISOString(),
        tenantId: 'flush',
        action: 'tools/call',
        toolName: 'local__t',
        traceId: 'trace-late',
        decision: 'allow'
      })
    ).rejects.toThrowError(/closed/i);

    // Write failures propagate to the caller (audit_unavailable upstream).
    const failing = new JsonlAuditStore(filePath, {
      sink: async () => {
        throw new Error('disk full');
      }
    });
    await expect(
      failing.record({
        timestamp: new Date().toISOString(),
        tenantId: 'flush',
        action: 'tools/call',
        toolName: 'local__t',
        traceId: 'trace-fail',
        decision: 'allow'
      })
    ).rejects.toThrowError('disk full');
    await failing.close();
  });

  it('bounds the pending queue and rejects new events when saturated', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gateway-audit-'));
    tempDirs.push(dir);
    const filePath = join(dir, 'audit-bounded.log');

    let releaseSink!: () => void;
    const sinkGate = new Promise<void>((resolve) => {
      releaseSink = resolve;
    });
    const store = new JsonlAuditStore(filePath, {
      maxPendingEvents: 2,
      sink: async () => {
        await sinkGate;
      }
    });

    const outcomes: Array<PromiseSettledResult<void>> = [];
    const record = (traceId: string) =>
      store
        .record({
          timestamp: new Date().toISOString(),
          tenantId: 'bounded',
          action: 'tools/call',
          toolName: 'local__t',
          traceId,
          decision: 'allow'
        })
        .then(
          () => outcomes.push({ status: 'fulfilled', value: undefined }),
          (error: unknown) => outcomes.push({ status: 'rejected', reason: error })
        );

    void record('t1'); // enters the (blocked) sink; pending = 1 queued
    void record('t2'); // pending = 2 -> saturated
    void record('t3'); // must reject with saturation

    await new Promise((resolve) => setTimeout(resolve, 20));
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(rejected.length).toBeGreaterThanOrEqual(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      category: 'audit_unavailable'
    });

    releaseSink();
    await store.close();
  });
});
