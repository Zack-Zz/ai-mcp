import { randomUUID, createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import {
  type BridgeConfig,
  type Caller,
  type EngineId,
  type ProjectConfig,
  parseStart,
  parseConfig,
  taskSpecSchema
} from '../contracts/validation.js';
import type {
  TaskRecord,
  EngineAdapter,
  EngineRunHandle,
  EngineOutcome,
  TaskState
} from '../contracts/types.js';
import { BridgeError, asBridgeError, type Disposition } from '../contracts/errors.js';
import { Journal, digest, assertOwnedFile } from '../runtime/journal.js';
import { createAdapters } from '../adapters/index.js';
import { inspectWorkspace, prepareWorkspace, captureDelivery } from '../workspaces/index.js';
import { RunLog } from '../runtime/run-log.js';
import { confirmStopped } from '../runtime/recovery.js';
import { executeTask } from './execution.js';

import type { WorkspacePort } from './ports.js';
export type { WorkspacePort } from './ports.js';

type Receipt = {
  owner: string;
  requestId: string;
  operation: string;
  fingerprint: string;
  taskId: string;
  input?: unknown;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    executionDisposition?: Disposition;
    details?: Record<string, unknown>;
  };
};
type Active = { controller: AbortController; handle?: EngineRunHandle; done: Promise<void> };
const taskIdSchema = z.string().regex(/^task_[0-9a-f-]{36}$/);
const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const getSchema = z.strictObject({ taskId: taskIdSchema });
const continueSchema = z.strictObject({
  taskId: taskIdSchema,
  requestId: requestIdSchema,
  message: z.string().min(1).max(32000)
});
const cancelSchema = z.strictObject({ taskId: taskIdSchema, requestId: requestIdSchema });
const terminal = new Set<TaskState>(['completed', 'failed', 'cancelled']);
const defaultWorkspace: WorkspacePort = {
  inspect: inspectWorkspace,
  prepare: prepareWorkspace,
  capture: captureDelivery
};
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success)
    throw new BridgeError(
      'INVALID_ARGUMENT',
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  return result.data;
}
const cloned = <T>(value: T): T => structuredClone(value);
const receiptKey = (owner: string, requestId: string) => JSON.stringify([owner, requestId]);

/** One durable writer. Control requests never own the spawned execution. */
export class BridgeApplication {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly receipts = new Map<string, Receipt>();
  private readonly active = new Map<string, Active>();
  private readonly pending = new Map<string, string | undefined>();
  private readonly changes = new EventEmitter();
  private mutation: Promise<unknown> = Promise.resolve();
  private closing = false;
  private failure: BridgeError | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly evidence = new Map<
    EngineId,
    { identity: string; version: string | null; capabilities: string[] }
  >();

  private constructor(
    private readonly config: BridgeConfig,
    private readonly journal: Journal,
    private readonly adapters: ReadonlyMap<EngineId, EngineAdapter>,
    private readonly workspace: WorkspacePort
  ) {}

  public static async open(
    config: BridgeConfig,
    options: { adapters?: ReadonlyMap<EngineId, EngineAdapter>; workspace?: WorkspacePort } = {}
  ): Promise<BridgeApplication> {
    const cfg = parseConfig(config);
    const app = new BridgeApplication(
      cfg,
      await Journal.open(cfg.stateRoot),
      options.adapters ?? createAdapters(),
      options.workspace ?? defaultWorkspace
    );
    for (const record of app.journal.records) {
      if (record.type === 'task.changed') {
        const task = record.data as TaskRecord;
        if (
          !taskIdSchema.safeParse(task.taskId).success ||
          !taskSpecSchema.safeParse(task.spec).success ||
          !task.owner?.id ||
          !Array.isArray(task.runs) ||
          !['read-only', 'workspace-write'].includes(task.permissionProfile) ||
          !/^[0-9a-f]{64}$/.test(task.projectConfigHash)
        )
          throw new BridgeError('STATE_CORRUPT', 'Invalid persisted task');
        app.tasks.set(task.taskId, task);
      } else if (record.type === 'operation.receipt') {
        const receipt = record.data as Receipt;
        app.receipts.set(receiptKey(receipt.owner, receipt.requestId), receipt);
      } else if (record.type === 'engine.evidence') {
        const entry = record.data as {
          engine: EngineId;
          identity: string;
          version: string | null;
          capabilities: string[];
        };
        app.evidence.set(entry.engine, entry);
      } else if (record.type === 'run.outcome') {
        const entry = record.data as { taskId: string; runId: string; outcome: EngineOutcome };
        const task = app.tasks.get(entry.taskId);
        if (task)
          app.tasks.set(task.taskId, {
            ...task,
            runs: task.runs.map((run) =>
              run.runId === entry.runId ? { ...run, outcome: entry.outcome } : run
            )
          });
      }
    }
    for (const task of [...app.tasks.values()]) {
      if (task.state === 'queued') {
        await app.save({
          ...task,
          state: 'cancelled',
          attention: {
            code: 'RUNTIME_RESTART',
            message:
              'Queued operation was not launched; explicit continuation or a new task is required'
          }
        });
        continue;
      }
      if (!terminal.has(task.state) && task.state !== 'recovery_required')
        await app.save({
          ...task,
          state: 'recovery_required',
          attention: {
            code: 'EXECUTION_UNKNOWN',
            message: 'Runtime restarted; verify previous run identity and code before continuing'
          }
        });
    }
    return app;
  }

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.mutation.then(action);
    this.mutation = operation.catch(() => undefined);
    return operation;
  }
  private async save(task: TaskRecord): Promise<TaskRecord> {
    const updated = { ...task, updatedAt: new Date().toISOString() };
    await this.journal.append('task.changed', updated);
    this.tasks.set(updated.taskId, updated);
    this.changes.emit('change');
    return cloned(updated);
  }
  private caller(ref: string): Caller {
    const caller = this.config.clients.find((client) => client.id === ref);
    if (!caller) throw new BridgeError('POLICY_DENIED', 'Unknown configured control client');
    return caller;
  }
  private task(caller: Caller, id: string): TaskRecord {
    const task = this.tasks.get(id);
    if (!task) throw new BridgeError('TASK_NOT_FOUND', 'No such task');
    if (task.owner.id !== caller.id)
      throw new BridgeError('POLICY_DENIED', 'Task belongs to a different originating client');
    return task;
  }
  private project(caller: Caller, id: string): ProjectConfig {
    const project = this.config.projects.find((item) => item.id === id);
    if (!project || (caller.projectIds && !caller.projectIds.includes(id)))
      throw new BridgeError('POLICY_DENIED', 'Project is not registered for this client');
    return project;
  }
  private writable(caller: Caller): void {
    if (caller.role !== 'controller')
      throw new BridgeError('POLICY_DENIED', 'Workers cannot originate Bridge mutations');
  }

  public async dispatch(callerRef: string, operation: string, input: unknown): Promise<unknown> {
    if (this.closing) throw new BridgeError('SERVICE_UNAVAILABLE', 'Runtime is closing');
    if (this.failure) throw this.failure;
    const caller = this.caller(callerRef);
    if (operation === 'engine.list') {
      parse(z.strictObject({}), input);
      const engines = await Promise.all(
        (['claude-code', 'zcode', 'codex'] as const).map(async (engine) => {
          const config = this.config.engines[engine];
          const adapter = this.adapters.get(engine);
          if (!config || !adapter)
            return { engine, available: false, version: null, reason: 'Engine is not configured' };
          return this.probe(engine);
        })
      );
      return {
        engines,
        preferredTargets: engines
          .filter((engine) => engine.available && engine.engine !== caller.engine)
          .map((engine) => engine.engine)
      };
    }
    if (operation === 'preflight') {
      const args = parse(
        z.strictObject({
          engine: z.enum(['claude-code', 'zcode', 'codex']),
          projectId: z.string(),
          taskSpec: taskSpecSchema.optional(),
          workspacePolicy: z.enum(['isolated', 'existing']).default('isolated'),
          sameEngineIntent: z.literal('independent-session').optional()
        }),
        input
      );
      const project = this.project(caller, args.projectId);
      return {
        engine: await this.probe(args.engine),
        workspace: await this.workspace.inspect(project, args.workspacePolicy, args.taskSpec),
        scopeChecked: !!args.taskSpec,
        authorizationEnforcement: 'instruction_and_config',
        independentSessionRequired: caller.engine === args.engine && !args.sameEngineIntent
      };
    }
    if (operation === 'task.start') {
      this.writable(caller);
      return this.serialize(() => this.start(caller, input));
    }
    if (operation === 'task.continue') {
      this.writable(caller);
      return this.serialize(() => this.continue(caller, input));
    }
    if (operation === 'task.cancel') {
      this.writable(caller);
      return this.serialize(() => this.cancel(caller, input));
    }
    if (operation === 'task.get') return cloned(this.task(caller, parse(getSchema, input).taskId));
    if (operation === 'task.list') {
      const args = parse(
        z.strictObject({
          limit: z.number().int().min(1).max(100).default(20),
          cursor: taskIdSchema.optional()
        }),
        input
      );
      const tasks = [...this.tasks.values()]
        .filter((task) => task.owner.id === caller.id)
        .sort((a, b) => a.taskId.localeCompare(b.taskId));
      const start = args.cursor ? tasks.findIndex((task) => task.taskId === args.cursor) + 1 : 0;
      if (args.cursor && !start) throw new BridgeError('INVALID_ARGUMENT', 'Unknown task cursor');
      const page = tasks.slice(start, start + args.limit);
      return {
        tasks: cloned(page),
        nextCursor: start + args.limit < tasks.length ? page.at(-1)?.taskId : null
      };
    }
    if (operation === 'task.watch') return this.watch(caller, input);
    if (operation === 'artifact.list')
      return {
        artifacts: this.task(caller, parse(getSchema, input).taskId)
          .deliveries.flatMap((delivery) => delivery.artifacts)
          .map(({ path, ...artifact }) => {
            void path;
            return artifact;
          })
      };
    if (operation === 'artifact.read') return this.readArtifact(caller, input);
    throw new BridgeError('INVALID_ARGUMENT', `Unknown operation ${operation}`);
  }

  private async probe(engine: EngineId) {
    const config = this.config.engines[engine];
    const adapter = this.adapters.get(engine);
    if (!config || !adapter)
      throw new BridgeError('ENGINE_UNAVAILABLE', 'Requested engine is not configured');
    const probe = await adapter.probe(config);
    const evidence = this.evidence.get(engine);
    if (evidence?.identity === digest(config) && evidence.version === probe.version)
      return {
        ...probe,
        evidence: 'runtime-verified',
        verifiedCapabilities: evidence.capabilities,
        capabilities: {
          ...probe.capabilities,
          ...Object.fromEntries(
            evidence.capabilities.map((capability) => [capability, 'supported'])
          )
        }
      };
    return probe;
  }
  private async ready(
    caller: Caller,
    engine: EngineId,
    operation: 'start' | 'continue' = 'start',
    profile?: ProjectConfig['permissionProfile']
  ): Promise<void> {
    const probe = await this.probe(engine);
    if (
      !probe.available ||
      probe.capabilities.newSession === 'unsupported' ||
      probe.capabilities.structuredEvents === 'unsupported'
    )
      throw new BridgeError(
        'ENGINE_UNAVAILABLE',
        'Requested engine lacks a required native interface'
      );
    if (profile === 'read-only' && probe.capabilities.readOnly === 'unsupported')
      throw new BridgeError(
        'UNSUPPORTED_CAPABILITY',
        'Requested engine cannot enforce the registered read-only profile'
      );
    const proven =
      'verifiedCapabilities' in probe
        ? (probe.verifiedCapabilities as string[])
        : probe.evidence === 'runtime-verified'
          ? ['newSession', 'continueSession', 'structuredEvents']
          : [];
    if (
      !caller.allowUnverified &&
      (!proven.includes(operation === 'start' ? 'newSession' : 'continueSession') ||
        !proven.includes('structuredEvents'))
    )
      throw new BridgeError(
        'UNSUPPORTED_CAPABILITY',
        'Native runtime evidence is missing; use an explicitly configured validation client first'
      );
  }
  private async receipt(
    caller: Caller,
    requestId: string,
    operation: string,
    input: unknown
  ): Promise<{ key: string; previous?: Receipt; fingerprint: string }> {
    const key = receiptKey(caller.id, requestId);
    const fingerprint = digest({ operation, input });
    const previous = this.receipts.get(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw new BridgeError(
        'IDEMPOTENCY_CONFLICT',
        'Request ID is already bound to different content'
      );
    return { key, fingerprint, ...(previous ? { previous } : {}) };
  }
  private replay(receipt: Receipt): unknown {
    if (receipt.error) {
      const fault = receipt.error;
      const prefix = `${fault.code}: `;
      throw new BridgeError(
        fault.code,
        fault.message.startsWith(prefix) ? fault.message.slice(prefix.length) : fault.message,
        fault.executionDisposition ?? 'unknown',
        fault.details
      );
    }
    if (receipt.data === undefined)
      throw new BridgeError(
        'EXECUTION_UNKNOWN',
        'Previous operation did not record its final response',
        'unknown',
        { taskId: receipt.taskId }
      );
    return cloned(receipt.data);
  }
  private async persistReceipt(receipt: Receipt): Promise<void> {
    await this.journal.append('operation.receipt', receipt);
    this.receipts.set(receiptKey(receipt.owner, receipt.requestId), receipt);
  }
  private assertSession(task: TaskRecord, sessionId: string): void {
    const valid =
      task.engine === 'zcode'
        ? /^sess_[A-Za-z0-9_-]+$/.test(sessionId)
        : /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(sessionId);
    if (
      !valid ||
      sessionId === task.owner.sessionId ||
      (task.sessionId && task.sessionId !== sessionId) ||
      [...this.tasks.values()].some(
        (other) =>
          other.taskId !== task.taskId &&
          other.engine === task.engine &&
          other.sessionId === sessionId
      )
    )
      throw new BridgeError(
        'SESSION_MISMATCH',
        'Native session did not match the independent task binding',
        'unknown'
      );
  }
  private async recover(task: TaskRecord, cancel: boolean): Promise<TaskRecord> {
    const run = task.runs.at(-1);
    await confirmStopped(run, cancel);
    if (!run)
      throw new BridgeError('EXECUTION_UNKNOWN', 'Previous run record is missing', 'unknown');
    const outcome = run.outcome ?? {
      status: 'failed' as const,
      message: 'Runtime exited before terminal evidence; previous process group is now absent',
      exitCode: null,
      executionDisposition: 'unknown' as const
    };
    const signal = AbortSignal.abort();
    const logs = await RunLog.read(this.config.stateRoot, task.taskId, run.runId);
    const delivery = await this.workspace.capture(this.config.stateRoot, task, run.runId, {
      ...logs,
      result: outcome,
      signal
    });
    return this.save({
      ...task,
      state: cancel ? 'cancelled' : 'failed',
      runs: task.runs.map((record) =>
        record.runId === run.runId
          ? {
              ...record,
              state: cancel ? 'cancelled' : 'failed',
              finishedAt: new Date().toISOString(),
              outcome
            }
          : record
      ),
      deliveries: [...task.deliveries, delivery],
      attention: {
        code: 'RECOVERED_UNCERTAIN_RUN',
        message:
          'Prior file state retained; native completion and verification were not inferred from process exit'
      }
    });
  }

  private async start(caller: Caller, input: unknown): Promise<TaskRecord> {
    const args = parseStart(input);
    const binding = await this.receipt(caller, args.requestId, 'task.start', args);
    if (binding.previous) return this.replay(binding.previous) as TaskRecord;
    if (caller.engine === args.engine && args.sameEngineIntent !== 'independent-session')
      throw new BridgeError(
        'POLICY_DENIED',
        'Same-engine dispatch requires explicit independent-session intent'
      );
    const project = this.project(caller, args.projectId);
    await this.ready(caller, args.engine, 'start', project.permissionProfile);
    const inspected = await this.workspace.inspect(project, args.workspacePolicy, args.taskSpec);
    if (this.closing) throw new BridgeError('SERVICE_UNAVAILABLE', 'Runtime is closing');
    const occupied = [...this.tasks.values()].some(
      (task) => !terminal.has(task.state) && task.workspaceRoot === inspected.repoRoot
    );
    if (args.workspacePolicy === 'existing' && occupied)
      throw new BridgeError(
        'WORKSPACE_BUSY',
        'Existing workspace already belongs to an active or unresolved task'
      );
    if (this.pending.size >= 32)
      throw new BridgeError('WORKSPACE_BUSY', 'Runtime queue capacity reached');
    const taskId = `task_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const provisional: TaskRecord = {
      taskId,
      engine: args.engine,
      projectId: project.id,
      owner: cloned(caller),
      state: 'queued',
      requestId: args.requestId,
      spec: args.taskSpec,
      sessionPolicy: 'new',
      workspacePolicy: args.workspacePolicy,
      workspaceId: taskId,
      permissionProfile: project.permissionProfile,
      projectConfigHash: digest(project),
      workspaceRoot:
        args.workspacePolicy === 'existing'
          ? inspected.repoRoot
          : join(this.config.stateRoot, 'workspaces', taskId),
      workingDirectory: inspected.workingDirectory,
      repoRoot: inspected.repoRoot,
      baselineRef: inspected.baselineRef,
      baselineSnapshotId: 'unmaterialized',
      createdAt,
      updatedAt: createdAt,
      runs: [],
      deliveries: []
    };
    const reserved: Receipt = {
      owner: caller.id,
      requestId: args.requestId,
      operation: 'task.start',
      fingerprint: binding.fingerprint,
      taskId,
      input: args
    };
    await this.persistReceipt(reserved);
    await this.save(provisional);
    try {
      const prepared = await this.workspace.prepare(
        this.config.stateRoot,
        project,
        args.workspacePolicy,
        taskId,
        args.taskSpec
      );
      const task = await this.save({ ...provisional, ...prepared });
      await this.persistReceipt({ ...reserved, data: task });
      this.schedule(taskId);
      return task;
    } catch (error) {
      const fault = asBridgeError(error);
      await this.save({
        ...provisional,
        state: 'failed',
        attention: { code: fault.code, message: fault.message }
      });
      await this.persistReceipt({
        ...reserved,
        error: {
          code: fault.code,
          message: fault.message,
          executionDisposition: fault.executionDisposition,
          ...(fault.details ? { details: fault.details } : {})
        }
      });
      throw fault;
    }
  }

  private async continue(caller: Caller, input: unknown): Promise<TaskRecord> {
    const args = parse(continueSchema, input);
    let task = this.task(caller, args.taskId);
    const receipt = await this.receipt(caller, args.requestId, 'task.continue', args);
    if (receipt.previous) return this.replay(receipt.previous) as TaskRecord;
    const project = this.project(caller, task.projectId);
    if (project.permissionProfile !== task.permissionProfile)
      throw new BridgeError(
        'POLICY_DENIED',
        'Task permission profile is immutable; changed permissions require a new explicitly delegated task'
      );
    if (digest(project) !== task.projectConfigHash)
      throw new BridgeError(
        'POLICY_DENIED',
        'Project registration or verification commands changed; create a new task under the new contract'
      );
    if (task.state === 'recovery_required') task = await this.recover(task, false);
    if (!terminal.has(task.state) || !task.sessionId)
      throw new BridgeError(
        'STATE_CONFLICT',
        'Task must be stopped with an exact persisted session before continuing'
      );
    await this.ready(caller, task.engine, 'continue', task.permissionProfile);
    if (this.closing) throw new BridgeError('SERVICE_UNAVAILABLE', 'Runtime is closing');
    if (
      [...this.tasks.values()].some(
        (other) =>
          other.taskId !== task.taskId &&
          !terminal.has(other.state) &&
          other.workspaceRoot === task.workspaceRoot
      )
    )
      throw new BridgeError(
        'WORKSPACE_BUSY',
        'Workspace is owned by another active or unresolved task'
      );
    const reserved = {
      owner: caller.id,
      requestId: args.requestId,
      operation: 'task.continue',
      fingerprint: receipt.fingerprint,
      taskId: task.taskId,
      input: args
    };
    await this.persistReceipt(reserved);
    const { attention, ...prior } = task;
    void attention;
    const updated = await this.save({ ...prior, state: 'queued' });
    await this.persistReceipt({ ...reserved, data: updated });
    this.schedule(task.taskId, args.message);
    return updated;
  }
  private async cancel(caller: Caller, input: unknown): Promise<TaskRecord> {
    const args = parse(cancelSchema, input);
    let task = this.task(caller, args.taskId);
    const receipt = await this.receipt(caller, args.requestId, 'task.cancel', args);
    if (receipt.previous) return this.replay(receipt.previous) as TaskRecord;
    if (task.state === 'recovery_required') task = await this.recover(task, true);
    const state = terminal.has(task.state)
      ? task.state
      : this.active.has(task.taskId)
        ? 'cancel_requested'
        : 'cancelled';
    const updated = await this.save({ ...task, state });
    this.pending.delete(task.taskId);
    this.active.get(task.taskId)?.controller.abort();
    if (this.active.get(task.taskId)?.handle)
      void this.active
        .get(task.taskId)!
        .handle!.interrupt()
        .catch(() => undefined);
    await this.persistReceipt({
      owner: caller.id,
      requestId: args.requestId,
      operation: 'task.cancel',
      fingerprint: receipt.fingerprint,
      taskId: task.taskId,
      data: updated
    });
    return updated;
  }

  private schedule(taskId: string, message?: string): void {
    if (!this.pending.has(taskId) || message !== undefined) this.pending.set(taskId, message);
    setImmediate(() => {
      if (this.closing || this.active.size || !this.pending.has(taskId)) return;
      const feedback = this.pending.get(taskId);
      this.pending.delete(taskId);
      const controller = new AbortController();
      const done = executeTask(
        {
          isClosing: () => this.closing,
          config: this.config,
          tasks: this.tasks,
          adapters: this.adapters,
          workspace: this.workspace,
          active: this.active,
          journal: this.journal,
          evidence: this.evidence,
          serialize: (action) => this.serialize(action),
          save: (task) => this.save(task),
          assertSession: (task, id) => this.assertSession(task, id)
        },
        taskId,
        controller,
        feedback ?? message
      ).catch((error) => {
        this.failure = asBridgeError(error);
      });
      this.active.set(taskId, { controller, done });
      void done.finally(() => {
        this.active.delete(taskId);
        const next = this.pending.keys().next().value as string | undefined;
        if (next) this.schedule(next, this.pending.get(next));
      });
    });
  }
  private async watch(caller: Caller, input: unknown): Promise<unknown> {
    const args = parse(
      z.strictObject({
        taskId: taskIdSchema,
        cursor: z
          .string()
          .regex(/^event_\d+$/)
          .optional(),
        waitMs: z.number().int().min(0).max(50000).default(0),
        limit: z.number().int().min(1).max(100).default(50)
      }),
      input
    );
    this.task(caller, args.taskId);
    const after = args.cursor ? Number(args.cursor.slice(6)) : 0;
    if (after > this.journal.records.length)
      throw new BridgeError('INVALID_ARGUMENT', 'Event cursor is ahead of the journal');
    const read = () =>
      this.journal.records
        .filter(
          (record) =>
            record.sequence > after &&
            record.type === 'task.changed' &&
            (record.data as TaskRecord).taskId === args.taskId
        )
        .slice(0, args.limit);
    if (!read().length && args.waitMs)
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.changes.off('change', done);
          resolve();
        };
        const timer = setTimeout(done, args.waitMs);
        this.changes.once('change', done);
      });
    const records = read();
    return {
      events: records.map((record) => ({
        cursor: `event_${record.sequence}`,
        timestamp: record.timestamp,
        type: record.type,
        data: {
          taskId: args.taskId,
          state: (record.data as TaskRecord).state,
          sessionId: (record.data as TaskRecord).sessionId ?? null
        }
      })),
      nextCursor: records.length ? `event_${records.at(-1)!.sequence}` : `event_${after}`,
      state: this.tasks.get(args.taskId)!.state
    };
  }
  private async readArtifact(caller: Caller, input: unknown): Promise<unknown> {
    const args = parse(
      z.strictObject({
        taskId: taskIdSchema,
        artifactId: z.string().min(1).max(128),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(65536).default(16384)
      }),
      input
    );
    const task = this.task(caller, args.taskId);
    const artifact = task.deliveries
      .flatMap((delivery) => delivery.artifacts)
      .find((entry) => entry.artifactId === args.artifactId);
    if (!artifact)
      throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact is not registered to this task');
    await assertOwnedFile(artifact.path);
    const path = await realpath(artifact.path);
    const root = await realpath(join(this.config.stateRoot, 'tasks', task.taskId));
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel))
      throw new BridgeError('ARTIFACT_NOT_FOUND', 'Artifact escaped its task state');
    const bytes = await readFile(path);
    if (
      bytes.length !== artifact.size ||
      createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
    )
      throw new BridgeError('ARTIFACT_CORRUPT', 'Artifact content no longer matches its delivery');
    if (args.offset > bytes.length)
      throw new BridgeError('INVALID_ARGUMENT', 'Artifact offset exceeds its length');
    const page = bytes.subarray(args.offset, args.offset + args.limit);
    const nextOffset = args.offset + page.length;
    return {
      artifactId: artifact.artifactId,
      name: artifact.name,
      sha256: artifact.sha256,
      size: artifact.size,
      offset: args.offset,
      bytesRead: page.length,
      nextOffset: nextOffset < bytes.length ? nextOffset : null,
      truncated: nextOffset < bytes.length,
      encoding: 'base64',
      data: page.toString('base64'),
      text: page.toString('utf8')
    };
  }
  public async idle(): Promise<void> {
    while (this.active.size || this.pending.size) {
      await Promise.all([...this.active.values()].map((active) => active.done));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await this.mutation;
    await this.journal.flush();
  }
  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      for (const taskId of this.pending.keys()) {
        const task = this.tasks.get(taskId);
        if (task) await this.serialize(() => this.save({ ...task, state: 'cancelled' }));
      }
      this.pending.clear();
      this.active.forEach((active) => active.controller.abort());
      await Promise.allSettled(
        [...this.active.values()].map(async (active) => {
          await active.handle?.interrupt();
          await active.done;
        })
      );
      await this.mutation;
      await this.journal.flush();
      this.changes.emit('change');
      this.changes.removeAllListeners();
    })();
    return this.closePromise;
  }
}
