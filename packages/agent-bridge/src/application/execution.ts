import type { BridgeConfig, EngineId } from '../contracts/validation.js';
import type {
  TaskRecord,
  Delivery,
  EngineAdapter,
  EngineRunHandle,
  EngineOutcome,
  EngineEvent,
  TaskState
} from '../contracts/types.js';
import { asBridgeError, BridgeError } from '../contracts/errors.js';
import { randomUUID } from 'node:crypto';
import { type Journal, digest } from '../runtime/journal.js';
import { processIdentity } from '../client/security.js';
import { RunLog } from '../runtime/run-log.js';
import type { WorkspacePort } from './ports.js';

export type ExecutionHost = {
  isClosing(): boolean;
  config: BridgeConfig;
  tasks: ReadonlyMap<string, TaskRecord>;
  adapters: ReadonlyMap<EngineId, EngineAdapter>;
  workspace: WorkspacePort;
  journal: Journal;
  active: Map<
    string,
    { controller: AbortController; handle?: EngineRunHandle; done: Promise<void> }
  >;
  evidence: Map<EngineId, { identity: string; version: string | null; capabilities: string[] }>;
  serialize<T>(action: () => Promise<T>): Promise<T>;
  save(task: TaskRecord): Promise<TaskRecord>;
  assertSession(task: TaskRecord, sessionId: string): void;
};

export async function executeTask(
  host: ExecutionHost,
  taskId: string,
  controller: AbortController,
  message?: string
): Promise<void> {
  const initial = host.tasks.get(taskId)!;
  if (initial.state !== 'queued' || host.isClosing()) return;
  const project = host.config.projects.find((item) => item.id === initial.projectId)!;
  const terminationProofRequired =
    initial.engine === 'codex' && host.config.engines.codex?.codexTransport !== 'exec';
  const runId = `run_${randomUUID()}`;
  const observed: Promise<unknown>[] = [];
  const log = await RunLog.open(
    host.config.stateRoot,
    taskId,
    runId,
    Math.min(initial.spec.limits?.maxLogBytes ?? host.config.maxLogBytes, host.config.maxLogBytes)
  );
  await host.serialize(async () => {
    const task = host.tasks.get(taskId)!;
    await host.save({
      ...task,
      state: 'running',
      runs: [
        ...task.runs,
        {
          runId,
          state: 'running',
          startedAt: new Date().toISOString(),
          ...(terminationProofRequired ? { terminationProofRequired: true } : {})
        }
      ]
    });
  });
  let outcome: EngineOutcome;
  let stopEvidence: Pick<EngineOutcome, 'executionStopped' | 'processGroupExited'> =
    terminationProofRequired ? { executionStopped: false } : {};
  let launchReturned = false;
  let executionFault: BridgeError | undefined;
  const track = (operation: Promise<unknown>) => {
    observed.push(operation);
    void operation.catch((error) => {
      executionFault = asBridgeError(error);
      controller.abort();
    });
  };
  const observe = (event: EngineEvent) => {
    track(log.append(event));
    if (
      event.kind === 'session' &&
      event.data &&
      typeof event.data === 'object' &&
      !Array.isArray(event.data) &&
      typeof event.data.sessionId === 'string'
    ) {
      const sessionId = event.data.sessionId;
      track(
        host.serialize(async () => {
          const task = host.tasks.get(taskId)!;
          host.assertSession(task, sessionId);
          await host.save({ ...task, sessionId });
        })
      );
    }
  };
  try {
    const handle = await host.adapters.get(initial.engine)!.launch(
      {
        runId,
        cwd: initial.workingDirectory,
        prompt: taskPrompt(initial, message),
        ...(initial.sessionId ? { sessionId: initial.sessionId } : {}),
        permissionProfile: initial.permissionProfile,
        config: host.config.engines[initial.engine]!,
        timeoutMs: Math.min(
          initial.spec.limits?.timeoutMs ?? host.config.timeoutMs,
          host.config.timeoutMs
        ),
        maxLogBytes: Math.min(
          initial.spec.limits?.maxLogBytes ?? host.config.maxLogBytes,
          host.config.maxLogBytes
        ),
        signal: controller.signal
      },
      observe
    );
    launchReturned = true;
    stopEvidence = { executionStopped: false };
    const active = host.active.get(taskId);
    if (active) active.handle = handle;
    if (controller.signal.aborted) await handle.interrupt();
    if (handle.pid)
      await host.serialize(async () => {
        const task = host.tasks.get(taskId)!;
        const identity = await processIdentity(handle.pid!);
        await host.save({
          ...task,
          runs: task.runs.map((run) =>
            run.runId === runId
              ? {
                  ...run,
                  pid: handle.pid!,
                  ...(identity ? { processStartIdentity: identity } : {})
                }
              : run
          )
        });
      });
    outcome = await handle.result;
    stopEvidence = {
      ...(outcome.executionStopped !== undefined
        ? { executionStopped: outcome.executionStopped }
        : {}),
      ...(outcome.processGroupExited !== undefined
        ? { processGroupExited: outcome.processGroupExited }
        : {})
    };
    await Promise.all(observed);
    if (outcome.sessionId) host.assertSession(host.tasks.get(taskId)!, outcome.sessionId);
  } catch (error) {
    controller.abort();
    const fault = executionFault ?? asBridgeError(error);
    executionFault = fault;
    if (!launchReturned && fault.executionDisposition === 'not_started')
      stopEvidence = { executionStopped: true };
    outcome = {
      status: 'failed',
      message: fault.message,
      exitCode: null,
      executionDisposition: fault.executionDisposition,
      ...stopEvidence
    };
  }
  await Promise.allSettled(observed);
  await log.outcome(outcome).catch((error) => {
    executionFault ??= asBridgeError(error);
  });
  await host.journal.append('run.outcome', { taskId, runId, outcome });
  const stopUnconfirmed =
    outcome.processGroupExited === false ||
    outcome.executionStopped === false ||
    (terminationProofRequired && outcome.executionStopped !== true);
  const task = host.tasks.get(taskId)!;
  let delivery: Delivery | undefined;
  let attention: TaskRecord['attention'] = executionFault && {
    code: executionFault.code,
    message: executionFault.message
  };
  if (!stopUnconfirmed)
    try {
      const logs = await RunLog.read(host.config.stateRoot, taskId, runId);
      delivery = await host.workspace.capture(host.config.stateRoot, task, runId, {
        ...logs,
        result: outcome,
        signal: controller.signal
      });
    } catch (error) {
      const fault = asBridgeError(error);
      attention = { code: fault.code, message: fault.message };
    }
  const verificationFailed = delivery?.verifications.some((result) => result.exitCode !== 0);
  const scopeFailed = !!delivery?.outOfScope.length;
  const state: TaskState = stopUnconfirmed
    ? 'recovery_required'
    : executionFault
      ? 'failed'
      : controller.signal.aborted
        ? 'cancelled'
        : outcome.status === 'completed' && delivery && !verificationFailed && !scopeFailed
          ? 'completed'
          : 'failed';
  if (state === 'recovery_required')
    attention = {
      code: 'EXECUTION_UNKNOWN',
      message: 'Native execution stop was not confirmed; workspace lease is retained'
    };
  await host.serialize(async () => {
    const latest = host.tasks.get(taskId)!;
    await host.save({
      ...latest,
      state,
      ...(outcome.sessionId ? { sessionId: outcome.sessionId } : {}),
      runs: latest.runs.map((run) =>
        run.runId === runId ? { ...run, state, finishedAt: new Date().toISOString(), outcome } : run
      ),
      deliveries: delivery ? [...latest.deliveries, delivery] : latest.deliveries,
      ...(attention
        ? { attention }
        : scopeFailed
          ? {
              attention: {
                code: 'SCOPE_VIOLATION',
                message: 'Delivery contains changes outside the approved write scope'
              }
            }
          : {})
    });
    if (!stopUnconfirmed && (state === 'completed' || outcome.status === 'cancelled')) {
      const probe = await host.adapters
        .get(initial.engine)!
        .probe(host.config.engines[initial.engine]!);
      const prior = host.evidence.get(initial.engine);
      const identity = digest(host.config.engines[initial.engine]);
      const capabilities = new Set(
        prior?.identity === identity && prior.version === probe.version ? prior.capabilities : []
      );
      if (state === 'completed') {
        capabilities.add(initial.sessionId ? 'continueSession' : 'newSession');
        capabilities.add('structuredEvents');
        if (project.permissionProfile === 'read-only') capabilities.add('readOnly');
      }
      if (outcome.status === 'cancelled') capabilities.add('cancel');
      const evidence = {
        engine: initial.engine,
        identity,
        version: probe.version,
        capabilities: [...capabilities]
      };
      await host.journal.append('engine.evidence', evidence);
      host.evidence.set(initial.engine, evidence);
    }
  });
}
function taskPrompt(task: TaskRecord, message?: string): string {
  return [
    'Execute this explicitly delegated task in the provided workspace.',
    `Objective: ${task.spec.objective}`,
    `Acceptance: ${JSON.stringify(task.spec.acceptanceCriteria)}`,
    `Write scope (relative to workspace): ${JSON.stringify(task.spec.writeScope)}`,
    `Constraints: ${JSON.stringify(task.spec.constraints)}`,
    `Context references: ${JSON.stringify(task.spec.contextRefs)}`,
    'Do not commit, push, tag, merge, publish, install global tools, change account/model settings, or dispatch new Bridge tasks.',
    'Verification commands are run by the controlled Bridge runner. Return a concise factual delivery and any unresolved issue.',
    ...(message ? [`Continue the same task within the original scope. Feedback: ${message}`] : [])
  ].join('\n');
}
