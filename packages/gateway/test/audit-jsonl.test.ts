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
      reason: 'rate limit exceeded'
    });

    const content = await readFile(filePath, 'utf8');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0] ?? '{}') as { traceId?: string; decision?: string };
    const second = JSON.parse(lines[1] ?? '{}') as { traceId?: string; decision?: string };

    expect(first.traceId).toBe('trace-1');
    expect(second.decision).toBe('deny');
  });
});
