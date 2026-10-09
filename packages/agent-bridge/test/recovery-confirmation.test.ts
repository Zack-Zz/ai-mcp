import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { confirmStopped } from '../src/runtime/recovery.js';
import type { RunRecord } from '../src/contracts/types.js';

describe('recovery termination evidence', () => {
  for (const outcome of [
    undefined,
    {
      status: 'failed' as const,
      message: 'Incomplete stop result',
      exitCode: 0,
      processGroupExited: true,
      executionDisposition: 'unknown' as const
    }
  ])
    it(`requires affirmative stop proof for a marked run with ${outcome ? 'incomplete' : 'missing'} outcome`, async () => {
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      expect(child.status).toBe(0);
      const run = {
        runId: 'run-proof-required',
        state: 'recovery_required' as const,
        startedAt: new Date().toISOString(),
        pid: child.pid,
        terminationProofRequired: true,
        ...(outcome ? { outcome } : {})
      };
      await expect(confirmStopped(run, true)).rejects.toThrow(/EXECUTION_UNKNOWN/);
      await expect(confirmStopped(run, false)).rejects.toThrow(/EXECUTION_UNKNOWN/);
    });

  it('allows a marked run with durable affirmative proof and absent leader/group', async () => {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(child.status).toBe(0);
    await expect(
      confirmStopped(
        {
          runId: 'run-stopped',
          state: 'recovery_required',
          startedAt: new Date().toISOString(),
          pid: child.pid,
          terminationProofRequired: true,
          outcome: {
            status: 'completed',
            message: 'Stopped with full proof',
            exitCode: 0,
            executionStopped: true,
            processGroupExited: true,
            executionDisposition: 'completed'
          }
        },
        true
      )
    ).resolves.toBeUndefined();
  });

  it('does not turn an absent native leader/group into proof that an escaped execution stopped', async () => {
    const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    expect(child.status).toBe(0);
    expect(child.pid).toBeGreaterThan(0);
    const run: RunRecord = {
      runId: 'run-escaped',
      state: 'recovery_required',
      startedAt: new Date().toISOString(),
      pid: child.pid,
      processStartIdentity: 'previously-owned-native-leader',
      outcome: {
        status: 'failed',
        message: 'Output holder still alive',
        exitCode: 0,
        processGroupExited: true,
        executionStopped: false,
        executionDisposition: 'unknown'
      }
    };
    await expect(confirmStopped(run, true)).rejects.toThrow(/EXECUTION_UNKNOWN/);
    await expect(confirmStopped(run, false)).rejects.toThrow(/EXECUTION_UNKNOWN/);
  });

  it('keeps explicit negative termination evidence ahead of the not-started shortcut', async () => {
    const run: RunRecord = {
      runId: 'run-inconsistent',
      state: 'recovery_required',
      startedAt: new Date().toISOString(),
      outcome: {
        status: 'failed',
        message: 'No complete stop proof',
        exitCode: null,
        executionStopped: false,
        executionDisposition: 'not_started'
      }
    };
    await expect(confirmStopped(run, true)).rejects.toThrow(/EXECUTION_UNKNOWN/);
  });
});
