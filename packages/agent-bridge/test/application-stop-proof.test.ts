import { describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeApplication, type WorkspacePort } from '../src/application/service.js';
import { parseConfig } from '../src/contracts/validation.js';
import { Journal } from '../src/runtime/journal.js';
import type {
  EngineAdapter,
  EngineOutcome,
  RunRecord,
  TaskRecord
} from '../src/contracts/types.js';

describe('durable native stop requirement', () => {
  for (const stopped of [false, true])
    it(`retains the lease after the outcome journal write fails, even with native stopped=${stopped}`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'bridge-stop-proof-'));
      const child = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
      expect(child.status).toBe(0);
      let beforeLaunch: RunRecord | undefined;
      const config = parseConfig({
        schemaVersion: 1,
        stateRoot: root,
        projects: [{ id: 'sample', repoRoot: root }],
        engines: { codex: { command: 'fixture' } },
        clients: [{ id: 'origin', role: 'controller', engine: 'zcode', allowUnverified: true }]
      });
      const capture = vi.fn<WorkspacePort['capture']>(async (_state, task, runId) => ({
        deliveryId: 'fixture-delivery',
        runId,
        snapshotId: 'after',
        baselineSnapshotId: task.baselineSnapshotId,
        createdAt: new Date().toISOString(),
        scopeEnforcement: 'detect_only',
        outOfScope: [],
        artifacts: [],
        verifications: []
      }));
      const workspace: WorkspacePort = {
        async inspect() {
          return {
            repoRoot: root,
            workingDirectory: root,
            baselineRef: 'baseline',
            dirty: false,
            permissionProfile: 'workspace-write',
            scopeEnforcement: 'detect_only'
          };
        },
        async prepare() {
          return {
            workspaceId: 'existing',
            workspaceRoot: root,
            workingDirectory: root,
            repoRoot: root,
            baselineRef: 'baseline',
            baselineSnapshotId: 'baseline-snapshot'
          };
        },
        capture
      };
      const outcome: EngineOutcome = {
        status: 'failed',
        message: 'Native result before persistence',
        exitCode: 0,
        processGroupExited: true,
        executionStopped: stopped,
        executionDisposition: 'unknown'
      };
      const adapter: EngineAdapter = {
        engine: 'codex',
        async probe() {
          return {
            engine: 'codex',
            available: true,
            version: 'fixture',
            evidence: 'interface-only',
            capabilities: {
              newSession: 'supported',
              continueSession: 'supported',
              structuredEvents: 'supported',
              readOnly: 'unverified',
              cancel: 'unverified'
            }
          };
        },
        async launch() {
          const journal = await Journal.open(root);
          const saved = journal.records.filter((record) => record.type === 'task.changed').at(-1)!;
          beforeLaunch = (saved.data as TaskRecord).runs.at(-1);
          return { pid: child.pid, result: Promise.resolve(outcome), async interrupt() {} };
        }
      };
      const args = {
        engine: 'codex',
        projectId: 'sample',
        requestId: 'first',
        workspacePolicy: 'existing',
        taskSpec: {
          taskSpecVersion: '1',
          objective: 'Inspect value',
          acceptanceCriteria: ['No capture before durable stop proof'],
          writeScope: ['src/**'],
          scopeReference: 'human:stop-proof-regression'
        }
      };
      const append = Journal.prototype.append;
      const failure = vi.spyOn(Journal.prototype, 'append').mockImplementation(async function (
        this: Journal,
        type,
        data
      ) {
        if (type === 'run.outcome')
          throw Object.assign(new Error('Fixture ENOSPC'), { code: 'ENOSPC' });
        return append.call(this, type, data);
      });
      let app: BridgeApplication | undefined;
      let reopened: BridgeApplication | undefined;
      try {
        app = await BridgeApplication.open(config, {
          adapters: new Map([['codex', adapter]]),
          workspace
        });
        const task = (await app.dispatch('origin', 'task.start', args)) as TaskRecord;
        await app.idle();
        await app.close();
        failure.mockRestore();
        const journal = await Journal.open(root);
        expect(journal.records.some((record) => record.type === 'run.outcome')).toBe(false);
        reopened = await BridgeApplication.open(config, {
          adapters: new Map([['codex', adapter]]),
          workspace
        });
        const recovered = (await reopened.dispatch('origin', 'task.get', {
          taskId: task.taskId
        })) as TaskRecord;
        expect(recovered.state).toBe('recovery_required');
        expect(recovered.runs[0]?.outcome).toBeUndefined();
        await expect(
          reopened.dispatch('origin', 'task.cancel', {
            taskId: task.taskId,
            requestId: 'cancel-after-lost-outcome'
          })
        ).rejects.toThrow(/EXECUTION_UNKNOWN/);
        await expect(
          reopened.dispatch('origin', 'task.continue', {
            taskId: task.taskId,
            requestId: 'resume-after-lost-outcome',
            message: 'Continue original scope'
          })
        ).rejects.toThrow(/EXECUTION_UNKNOWN/);
        await expect(
          reopened.dispatch('origin', 'task.start', {
            ...args,
            requestId: 'next-writer'
          })
        ).rejects.toThrow(/WORKSPACE_BUSY/);
        expect(capture).not.toHaveBeenCalled();
        expect(beforeLaunch).toMatchObject({ terminationProofRequired: true });
        expect(recovered.runs[0]).toMatchObject({ terminationProofRequired: true });
      } finally {
        failure.mockRestore();
        await reopened?.close();
        await app?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
});
