import { describe, expect, it } from 'vitest';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { BridgeApplication } from '../src/application/service.js';
import type { EngineOutcome, TaskRecord } from '../src/contracts/types.js';
import { Journal } from '../src/runtime/journal.js';
import { BridgeError } from '../src/contracts/errors.js';
import { harness, pause, spec } from './application-harness.js';

describe('Explicit durable task operations', () => {
  it('replays a failed start with its original error details and execution certainty after restart', async () => {
    const h = await harness();
    let reopened: BridgeApplication | undefined;
    const fault = new BridgeError('WORKSPACE_BUSY', 'Fixture preparation refused', 'not_started', {
      path: 'fixture'
    });
    try {
      h.workspace.prepare = async () => {
        throw fault;
      };
      await expect(h.app.dispatch('origin', 'task.start', h.args)).rejects.toMatchObject({
        code: fault.code,
        message: fault.message,
        executionDisposition: 'not_started',
        details: fault.details
      });
      await h.app.close();
      reopened = await BridgeApplication.open(h.config, {
        adapters: new Map([['codex', h.adapter]]),
        workspace: h.workspace
      });
      await expect(reopened.dispatch('origin', 'task.start', h.args)).rejects.toMatchObject({
        code: fault.code,
        message: fault.message,
        executionDisposition: 'not_started',
        details: fault.details
      });
      expect(h.launches()).toBe(0);
    } finally {
      await reopened?.close();
      await h.cleanup();
    }
  });
  it('keeps valid colon-containing caller and request identities in separate idempotency namespaces', async () => {
    const h = await harness();
    try {
      const first = (await h.app.dispatch('origin', 'task.start', {
        ...h.args,
        requestId: 'sub:request'
      })) as TaskRecord;
      const second = (await h.app.dispatch('origin:sub', 'task.start', {
        ...h.args,
        requestId: 'request'
      })) as TaskRecord;
      expect(first.taskId).not.toBe(second.taskId);
      expect(second.owner.id).toBe('origin:sub');
    } finally {
      await h.cleanup();
    }
  });
  it('releases a recovered lease when durable native evidence proves the launch never started', async () => {
    const h = await harness();
    let reopened: BridgeApplication | undefined;
    try {
      h.adapter.launch = async () => {
        throw new BridgeError('ENGINE_UNAVAILABLE', 'Fixture could not spawn', 'not_started');
      };
      const task = (await h.app.dispatch('origin', 'task.start', {
        ...h.args,
        workspacePolicy: 'existing'
      })) as TaskRecord;
      await h.app.idle();
      const failed = (await h.app.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      await h.app.close();
      const run = failed.runs[0]!;
      const journal = await Journal.open(h.root);
      await journal.append('task.changed', {
        ...failed,
        state: 'running',
        runs: [{ runId: run.runId, state: 'running', startedAt: run.startedAt }]
      });
      await journal.append('run.outcome', {
        taskId: task.taskId,
        runId: run.runId,
        outcome: run.outcome
      });
      reopened = await BridgeApplication.open(h.config, {
        adapters: new Map([['codex', h.adapter]]),
        workspace: h.workspace
      });
      const cancelled = (await reopened.dispatch('origin', 'task.cancel', {
        taskId: task.taskId,
        requestId: 'stop-not-started'
      })) as TaskRecord;
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.runs[0]!.outcome?.executionDisposition).toBe('not_started');
    } finally {
      await reopened?.close();
      await h.cleanup();
    }
  });
  it('does not widen a persisted task permission profile after configuration changes', async () => {
    const h = await harness('read-only');
    let reopened: BridgeApplication | undefined;
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      await h.app.close();
      const changed = {
        ...h.config,
        projects: h.config.projects.map((project) => ({
          ...project,
          permissionProfile: 'workspace-write' as const
        }))
      };
      reopened = await BridgeApplication.open(changed, {
        adapters: new Map([['codex', h.adapter]]),
        workspace: h.workspace
      });
      await expect(
        reopened.dispatch('origin', 'task.continue', {
          taskId: task.taskId,
          requestId: 'widen-permission',
          message: 'Continue'
        })
      ).rejects.toThrow(/POLICY_DENIED/);
      expect(h.launches()).toBe(1);
    } finally {
      await reopened?.close();
      await h.cleanup();
    }
  });
  it('does not continue against a changed project registration or verification command set', async () => {
    const h = await harness();
    let reopened: BridgeApplication | undefined;
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      await h.app.close();
      const changed = {
        ...h.config,
        projects: h.config.projects.map((project) => ({
          ...project,
          repoRoot: join(project.repoRoot, 'other-registration')
        }))
      };
      reopened = await BridgeApplication.open(changed, {
        adapters: new Map([['codex', h.adapter]]),
        workspace: h.workspace
      });
      await expect(
        reopened.dispatch('origin', 'task.continue', {
          taskId: task.taskId,
          requestId: 'changed-project',
          message: 'Continue'
        })
      ).rejects.toThrow(/POLICY_DENIED/);
      expect(h.launches()).toBe(1);
    } finally {
      await reopened?.close();
      await h.cleanup();
    }
  });
  it('discovers preferred other engines, scopes preflight and paginates only owned tasks without dispatching from reads', async () => {
    const h = await harness();
    try {
      const engines = (await h.app.dispatch('other', 'engine.list', {})) as {
        preferredTargets: string[];
      };
      expect(engines.preferredTargets).toEqual(['codex']);
      const preflight = (await h.app.dispatch('origin', 'preflight', {
        engine: 'codex',
        projectId: 'p'
      })) as { scopeChecked: boolean; independentSessionRequired: boolean };
      expect(preflight).toMatchObject({ scopeChecked: false, independentSessionRequired: true });
      expect(h.launches()).toBe(0);
      await expect(
        h.app.dispatch('origin', 'preflight', { engine: 'codex', projectId: 'unregistered' })
      ).rejects.toThrow(/POLICY_DENIED/);
      await expect(h.app.dispatch('origin', 'engine.list', { approved: true })).rejects.toThrow(
        /INVALID_ARGUMENT/
      );
      await h.app.dispatch('origin', 'task.start', h.args);
      await h.app.dispatch('origin', 'task.start', { ...h.args, requestId: 'second-isolated' });
      const first = (await h.app.dispatch('origin', 'task.list', { limit: 1 })) as {
        tasks: TaskRecord[];
        nextCursor: string;
      };
      const second = (await h.app.dispatch('origin', 'task.list', {
        limit: 1,
        cursor: first.nextCursor
      })) as { tasks: TaskRecord[]; nextCursor: null };
      expect(first.tasks).toHaveLength(1);
      expect(second.tasks).toHaveLength(1);
      expect(second.nextCursor).toBe(null);
      expect(await h.app.dispatch('other', 'task.list', {})).toEqual({
        tasks: [],
        nextCursor: null
      });
      await expect(
        h.app.dispatch('origin', 'task.list', {
          cursor: 'task_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
        })
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(h.app.dispatch('origin', 'unknown', {})).rejects.toThrow(/INVALID_ARGUMENT/);
    } finally {
      await h.cleanup();
    }
  });
  it('waits for a task change and validates durable watch cursors', async () => {
    const h = await harness();
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      await pause();
      const current = (await h.app.dispatch('origin', 'task.watch', { taskId: task.taskId })) as {
        nextCursor: string;
        events: unknown[];
      };
      expect(current.events.length).toBeGreaterThan(0);
      const waiting = h.app.dispatch('origin', 'task.watch', {
        taskId: task.taskId,
        cursor: current.nextCursor,
        waitMs: 1000
      });
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      expect(((await waiting) as { events: unknown[] }).events.length).toBeGreaterThan(0);
      await h.app.idle();
      await expect(
        h.app.dispatch('origin', 'task.watch', { taskId: task.taskId, cursor: 'event_999999' })
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      const latest = (await h.app.dispatch('origin', 'task.watch', { taskId: task.taskId })) as {
        nextCursor: string;
      };
      expect(
        (
          (await h.app.dispatch('origin', 'task.watch', {
            taskId: task.taskId,
            cursor: latest.nextCursor,
            waitMs: 5
          })) as { events: unknown[] }
        ).events
      ).toEqual([]);
    } finally {
      await h.cleanup();
    }
  });
  it('reads private registered artifact pages, verifies their bytes and rejects a corrupted delivery', async () => {
    const h = await harness();
    try {
      h.workspace.capture = async (_state: string, task: TaskRecord, runId: string) => {
        const directory = join(h.root, 'tasks', task.taskId, 'deliveries', runId);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const path = join(directory, 'result.txt');
        await writeFile(path, '0123456789', { mode: 0o600 });
        return {
          deliveryId: runId,
          runId,
          snapshotId: 'after',
          baselineSnapshotId: task.baselineSnapshotId,
          createdAt: new Date().toISOString(),
          scopeEnforcement: 'detect_only',
          outOfScope: [],
          artifacts: [
            {
              artifactId: 'artifact-fixture',
              kind: 'result',
              name: 'result.txt',
              path,
              size: 10,
              sha256: createHash('sha256').update('0123456789').digest('hex')
            }
          ],
          verifications: []
        };
      };
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      const args = { taskId: task.taskId, artifactId: 'artifact-fixture', offset: 2, limit: 3 };
      expect(await h.app.dispatch('origin', 'artifact.read', args)).toMatchObject({
        text: '234',
        bytesRead: 3,
        nextOffset: 5,
        truncated: true
      });
      expect(
        await h.app.dispatch('origin', 'artifact.list', { taskId: task.taskId })
      ).toMatchObject({ artifacts: [{ artifactId: 'artifact-fixture' }] });
      await expect(
        h.app.dispatch('origin', 'artifact.read', { ...args, offset: 11 })
      ).rejects.toThrow(/INVALID_ARGUMENT/);
      await expect(
        h.app.dispatch('origin', 'artifact.read', { ...args, artifactId: 'another' })
      ).rejects.toThrow(/ARTIFACT_NOT_FOUND/);
      const completed = (await h.app.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      await writeFile(completed.deliveries[0]!.artifacts[0]!.path, 'corruption');
      await expect(h.app.dispatch('origin', 'artifact.read', args)).rejects.toThrow(
        /ARTIFACT_CORRUPT/
      );
    } finally {
      await h.cleanup();
    }
  });
  it('does not resume an older task while another task owns its existing workspace', async () => {
    const h = await harness();
    try {
      const task = (await h.app.dispatch('origin', 'task.start', {
        ...h.args,
        workspacePolicy: 'existing'
      })) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      await h.app.dispatch('origin', 'task.start', {
        ...h.args,
        workspacePolicy: 'existing',
        requestId: 'new-owner'
      });
      await expect(
        h.app.dispatch('origin', 'task.continue', {
          taskId: task.taskId,
          requestId: 'old-owner',
          message: 'Continue'
        })
      ).rejects.toThrow(/WORKSPACE_BUSY/);
    } finally {
      await h.cleanup();
    }
  });
  it('rejects a terminal session identity that differs from the observed native session', async () => {
    const h = await harness();
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '99999999-1111-4111-8111-111111111111',
        message: 'Wrong session',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      const result = (await h.app.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      expect(result.state).toBe('failed');
      expect(result.sessionId).toBe('11111111-1111-4111-8111-111111111111');
      expect(result.attention?.code).toBe('SESSION_MISMATCH');
    } finally {
      await h.cleanup();
    }
  });
  it('persists partial native events before a still-running model returns', async () => {
    const h = await harness();
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      const running = (await h.app.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      const path = join(
        h.root,
        'tasks',
        task.taskId,
        'runs',
        running.runs[0]!.runId,
        'stdout.jsonl'
      );
      let content: string | null = null;
      for (let i = 0; content === null && i < 100; i++) {
        content = await readFile(path, 'utf8').catch(() => null);
        if (content === null) await pause();
      }
      expect(content).toContain('11111111-1111-4111-8111-111111111111');
    } finally {
      await h.cleanup();
    }
  });
  it('retains crash uncertainty and lets an explicit continuation recover a confirmed absent owned process', async () => {
    const h = await harness();
    let reopened: BridgeApplication | undefined;
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      const completed = (await h.app.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      await h.app.close();
      const previousRun = {
        runId: completed.runs[0]!.runId,
        state: 'running' as const,
        startedAt: completed.createdAt,
        pid: 2147483647,
        processStartIdentity: 'proven-previous-start'
      };
      const journal = await Journal.open(h.root);
      await journal.append('task.changed', { ...completed, state: 'running', runs: [previousRun] });
      reopened = await BridgeApplication.open(h.config, {
        adapters: new Map([['codex', h.adapter]]),
        workspace: h.workspace
      });
      expect(
        ((await reopened.dispatch('origin', 'task.get', { taskId: task.taskId })) as TaskRecord)
          .state
      ).toBe('recovery_required');
      expect(h.launches()).toBe(1);
      await reopened.dispatch('origin', 'task.continue', {
        taskId: task.taskId,
        requestId: 'recover-explicit',
        message: 'Continue original scope after crash'
      });
      for (let i = 0; h.launches() < 2 && i < 100; i++) await pause();
      const running = (await reopened.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      expect(running.sessionId).toBe(completed.sessionId);
      expect(running.runs[0]?.outcome?.executionDisposition).toBe('unknown');
    } finally {
      await reopened?.close();
      await h.cleanup();
    }
  });
  it('does not treat a successful cancellation as verified new-session execution capability', async () => {
    const h = await harness();
    try {
      h.adapter.probe = async () => ({
        engine: 'codex',
        available: true,
        version: 'fixture',
        evidence: 'interface-only',
        capabilities: {
          newSession: 'supported',
          continueSession: 'supported',
          structuredEvents: 'supported',
          cancel: 'unverified',
          readOnly: 'unverified'
        }
      });
      await h.app.dispatch('origin', 'task.start', h.args);
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'cancelled',
        message: 'Stopped',
        exitCode: null,
        executionDisposition: 'unknown'
      });
      await h.app.idle();
      await h.app.close();
      const config = {
        ...h.config,
        clients: h.config.clients.map((client) => ({ ...client, allowUnverified: false }))
      };
      const reopened = await BridgeApplication.open(config, {
        adapters: new Map([['codex', h.adapter]]),
        workspace: h.workspace
      });
      try {
        await expect(
          reopened.dispatch('origin', 'task.start', { ...h.args, requestId: 'after-cancel' })
        ).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
      } finally {
        await reopened.close();
      }
    } finally {
      await h.cleanup();
    }
  });
  it('requires a validation run after upgrading implicit Codex exec transport instead of reusing the previous runtime proof', async () => {
    const h = await harness();
    let reopened: BridgeApplication | undefined;
    try {
      await h.app.close();
      h.adapter.probe = async () => ({
        engine: 'codex',
        available: true,
        version: 'fixture',
        evidence: 'interface-only',
        capabilities: {
          newSession: 'supported',
          continueSession: 'supported',
          structuredEvents: 'supported',
          cancel: 'unverified',
          readOnly: 'unsupported'
        }
      });
      const legacyIdentity = createHash('sha256')
        .update('{"args":[],"command":"fixture","env":{},"pluginDirs":[]}')
        .digest('hex');
      const journal = await Journal.open(h.root);
      await journal.append('engine.evidence', {
        engine: 'codex',
        identity: legacyIdentity,
        version: 'fixture',
        capabilities: ['newSession', 'continueSession', 'structuredEvents']
      });
      reopened = await BridgeApplication.open(
        {
          ...h.config,
          clients: h.config.clients.map((client) => ({ ...client, allowUnverified: false }))
        },
        { adapters: new Map([['codex', h.adapter]]), workspace: h.workspace }
      );
      await expect(reopened.dispatch('origin', 'task.start', h.args)).rejects.toThrow(
        /UNSUPPORTED_CAPABILITY/
      );
      expect(h.launches()).toBe(0);
    } finally {
      await reopened?.close();
      await h.cleanup();
    }
  });
  it('quarantines a workspace when a stopped group has an unconfirmed execution and never publishes a delivery or permits another writer', async () => {
    const h = await harness();
    let reopened: BridgeApplication | undefined;
    try {
      const capture = h.workspace.capture;
      const marker = join(h.root, 'capture-ran.txt');
      h.workspace.capture = async (...args) => {
        await writeFile(marker, 'Captured while an escaped writer could still be active');
        return capture(...args);
      };
      const task = (await h.app.dispatch('origin', 'task.start', {
        ...h.args,
        workspacePolicy: 'existing'
      })) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'failed',
        message: 'Native output holder remains active',
        exitCode: 0,
        processGroupExited: true,
        executionStopped: false,
        executionDisposition: 'unknown'
      });
      await h.app.idle();
      const unknown = (await h.app.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      expect(unknown.state).toBe('recovery_required');
      expect(unknown.deliveries).toHaveLength(0);
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        h.app.dispatch('origin', 'task.start', {
          ...h.args,
          workspacePolicy: 'existing',
          requestId: 'next-writer'
        })
      ).rejects.toThrow(/WORKSPACE_BUSY/);
      await h.app.close();
      reopened = await BridgeApplication.open(h.config, {
        adapters: new Map([['codex', h.adapter]]),
        workspace: h.workspace
      });
      expect(
        ((await reopened.dispatch('origin', 'task.get', { taskId: task.taskId })) as TaskRecord)
          .state
      ).toBe('recovery_required');
      await expect(
        reopened.dispatch('origin', 'task.start', {
          ...h.args,
          workspacePolicy: 'existing',
          requestId: 'writer-after-restart'
        })
      ).rejects.toThrow(/WORKSPACE_BUSY/);
    } finally {
      await reopened?.close();
      await h.cleanup();
    }
  });
  it('preserves negative native stop evidence when durable event recording fails before delivery', async () => {
    const h = await harness();
    let app: BridgeApplication | undefined;
    try {
      await h.app.close();
      const native: EngineOutcome = {
        status: 'failed',
        message: 'Native output holder remains active',
        exitCode: 0,
        processGroupExited: true,
        executionStopped: false,
        executionDisposition: 'unknown'
      };
      h.adapter.launch = async (_input, observe) => {
        observe({ kind: 'diagnostic', data: { message: 'x'.repeat(2048) } });
        return { pid: undefined, result: Promise.resolve(native), async interrupt() {} };
      };
      app = await BridgeApplication.open(
        { ...h.config, maxLogBytes: 1024 },
        {
          adapters: new Map([['codex', h.adapter]]),
          workspace: h.workspace
        }
      );
      const task = (await app.dispatch('origin', 'task.start', {
        ...h.args,
        workspacePolicy: 'existing'
      })) as TaskRecord;
      await app.idle();
      const stored = (await app.dispatch('origin', 'task.get', {
        taskId: task.taskId
      })) as TaskRecord;
      expect(stored.state).toBe('recovery_required');
      expect(stored.runs[0]?.outcome).toMatchObject({
        executionStopped: false,
        processGroupExited: true
      });
      expect(stored.deliveries).toHaveLength(0);
      await expect(
        app.dispatch('origin', 'task.start', {
          ...h.args,
          workspacePolicy: 'existing',
          requestId: 'writer-after-log-failure'
        })
      ).rejects.toThrow(/WORKSPACE_BUSY/);
    } finally {
      await app?.close();
      await h.cleanup();
    }
  });
  it('preserves continuation feedback while the task is queued behind another workspace', async () => {
    const h = await harness();
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      await h.app.dispatch('origin', 'task.start', { ...h.args, requestId: 'other-workspace' });
      for (let i = 0; h.launches() < 2 && i < 100; i++) await pause();
      await h.app.dispatch('origin', 'task.continue', {
        taskId: task.taskId,
        requestId: 'feedback',
        message: 'Preserve this exact queued feedback'
      });
      h.outcomes[1]?.({
        status: 'completed',
        sessionId: '22222222-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      for (let i = 0; h.launches() < 3 && i < 100; i++) await pause();
      expect(h.prompts[2]).toContain('Preserve this exact queued feedback');
    } finally {
      await h.cleanup();
    }
  });
  it('refuses default same-engine new and worker dispatch without spawning', async () => {
    const h = await harness();
    try {
      await expect(
        h.app.dispatch('origin', 'task.start', { ...h.args, sameEngineIntent: undefined })
      ).rejects.toThrow(/POLICY_DENIED/);
      await expect(h.app.dispatch('worker', 'task.start', h.args)).rejects.toThrow(/POLICY_DENIED/);
      expect(h.launches()).toBe(0);
    } finally {
      await h.cleanup();
    }
  });
  it('serializes duplicate request IDs, returns one task and never replays the native call', async () => {
    const h = await harness();
    try {
      const tasks = (await Promise.all(
        Array.from({ length: 5 }, () => h.app.dispatch('origin', 'task.start', h.args))
      )) as TaskRecord[];
      expect(new Set(tasks.map((task) => task.taskId)).size).toBe(1);
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      expect(h.launches()).toBe(1);
      await expect(
        h.app.dispatch('origin', 'task.start', {
          ...h.args,
          taskSpec: { ...spec, objective: 'Different' }
        })
      ).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
      h.outcomes[0]?.({
        status: 'completed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Done',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      await h.app.idle();
      const task = (await h.app.dispatch('origin', 'task.get', {
        taskId: tasks[0]!.taskId
      })) as TaskRecord;
      expect(task.state).toBe('completed');
      expect(task.sessionId).toBe('11111111-1111-4111-8111-111111111111');
      expect(task.deliveries).toHaveLength(1);
      await expect(h.app.dispatch('other', 'task.get', { taskId: task.taskId })).rejects.toThrow(
        /POLICY_DENIED/
      );
    } finally {
      await h.cleanup();
    }
  });
});
