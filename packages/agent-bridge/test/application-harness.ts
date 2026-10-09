import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeApplication, type WorkspacePort } from '../src/application/service.js';
import { parseConfig } from '../src/contracts/validation.js';
import type { EngineAdapter, EngineOutcome, TaskRecord } from '../src/contracts/types.js';

export const spec = {
  taskSpecVersion: '1',
  objective: 'Explicit user task',
  acceptanceCriteria: ['Fixture finishes'],
  constraints: [],
  writeScope: ['**'],
  contextRefs: [],
  verificationIds: [],
  scopeReference: 'user-message:goal'
};
export const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
export async function harness(profile: 'read-only' | 'workspace-write' = 'workspace-write') {
  const root = await mkdtemp(join(tmpdir(), 'bridge-app-'));
  let launches = 0;
  const outcomes: Array<(result: EngineOutcome) => void> = [];
  const prompts: string[] = [];
  const config = parseConfig({
    schemaVersion: 1,
    stateRoot: root,
    projects: [{ id: 'p', repoRoot: root, permissionProfile: profile }],
    engines: { codex: { command: 'fixture' } },
    clients: [
      {
        id: 'origin',
        role: 'controller',
        engine: 'codex',
        sessionId: 'origin-session',
        allowUnverified: true
      },
      { id: 'other', role: 'controller', engine: 'zcode', allowUnverified: true },
      { id: 'origin:sub', role: 'controller', engine: 'zcode', allowUnverified: true },
      { id: 'worker', role: 'worker' }
    ]
  });
  const adapter: EngineAdapter = {
    engine: 'codex',
    async probe() {
      return {
        engine: 'codex',
        available: true,
        version: 'fixture',
        evidence: 'runtime-verified',
        capabilities: {
          newSession: 'supported',
          continueSession: 'supported',
          structuredEvents: 'supported',
          cancel: 'supported',
          readOnly: 'supported'
        }
      };
    },
    async launch(input, observe) {
      launches++;
      prompts.push(input.prompt);
      // This in-memory adapter has no native process and resolves only after its simulated stop.
      const result = new Promise<EngineOutcome>((resolve) =>
        outcomes.push((outcome) =>
          resolve({ processGroupExited: true, executionStopped: true, ...outcome })
        )
      );
      observe({
        kind: 'session',
        data: {
          sessionId: input.sessionId ?? `${String(launches).repeat(8)}-1111-4111-8111-111111111111`
        }
      });
      return {
        pid: undefined,
        result,
        async interrupt() {
          outcomes.at(-1)?.({
            status: 'cancelled',
            message: 'Stopped',
            exitCode: null,
            executionDisposition: 'unknown'
          });
        }
      };
    }
  };
  const workspace: WorkspacePort = {
    async inspect() {
      return {
        repoRoot: root,
        workingDirectory: root,
        baselineRef: 'baseline',
        dirty: false,
        permissionProfile: 'workspace-write',
        scopeEnforcement: 'detect_only' as const
      };
    },
    async prepare(_state: string, _project: unknown, policy: string, taskId: string) {
      return {
        workspaceId: taskId,
        workspaceRoot: policy === 'existing' ? root : join(root, taskId),
        workingDirectory: policy === 'existing' ? root : join(root, taskId),
        repoRoot: root,
        baselineRef: 'baseline',
        baselineSnapshotId: 'snapshot'
      };
    },
    async capture(_state: string, task: TaskRecord, runId: string) {
      return {
        deliveryId: 'delivery',
        runId,
        snapshotId: 'after',
        baselineSnapshotId: task.baselineSnapshotId,
        createdAt: new Date().toISOString(),
        scopeEnforcement: 'detect_only' as const,
        outOfScope: [],
        artifacts: [],
        verifications: []
      };
    }
  };
  const app = await BridgeApplication.open(config, {
    adapters: new Map([['codex', adapter]]),
    workspace
  });
  return {
    root,
    config,
    app,
    workspace,
    adapter,
    launches: () => launches,
    outcomes,
    prompts,
    args: {
      engine: 'codex',
      projectId: 'p',
      requestId: 'request-1',
      sameEngineIntent: 'independent-session',
      taskSpec: spec
    },
    async cleanup() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  };
}
