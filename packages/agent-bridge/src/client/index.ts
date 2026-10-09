import { createConnection } from 'node:net';
import type { BridgeConfig } from '../contracts/validation.js';
import { parseConfig } from '../contracts/validation.js';
import { BridgeError } from '../contracts/errors.js';
import {
  endpoint,
  readBinding,
  assertBinding,
  processAbsent,
  credential,
  assertPrivate,
  type RuntimeBinding,
  type Endpoint
} from './security.js';
import { lstat } from 'node:fs/promises';
import { MAX_FRAME_BYTES, OPERATIONS, requestId, unwrapReply } from './protocol.js';
import { signRequest, verifyReply } from './authentication.js';
import { digest } from '../runtime/journal.js';
import type { TaskRecord } from '../contracts/types.js';
import type {
  StartTaskArgs,
  TaskArgs,
  ContinueTaskArgs,
  CancelTaskArgs,
  ListTaskArgs,
  WatchTaskArgs,
  PreflightArgs,
  EngineList,
  Preflight,
  TaskList,
  TaskEvents,
  ArtifactList,
  ReadArtifactArgs,
  ArtifactPage
} from '../contracts/operations.js';

export type ConnectOptions = {
  callerRef?: string;
  timeoutMs?: number;
  bootstrap?: () => Promise<void>;
};
async function publishedBinding(path: string, deadline: number): Promise<RuntimeBinding | null> {
  for (;;) {
    try {
      return await readBinding(path);
    } catch (error) {
      if (
        !(error instanceof BridgeError) ||
        error.code !== 'STATE_CORRUPT' ||
        performance.now() >= deadline
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(50, Math.max(0, deadline - performance.now())))
      );
    }
  }
}
export class BridgeClient {
  private constructor(
    private readonly target: Endpoint,
    private readonly callerRef: string,
    private readonly token: string,
    private readonly timeoutMs: number,
    private readonly bindingHash: string
  ) {}
  public static async connect(
    config: BridgeConfig,
    options: ConnectOptions = {}
  ): Promise<BridgeClient> {
    const cfg = parseConfig(config);
    const target = await endpoint(cfg);
    const callerRef = options.callerRef ?? cfg.defaultCallerRef;
    const caller = cfg.clients.find((client) => client.id === callerRef);
    if (!caller) throw new BridgeError('AUTH_REQUIRED', 'Select a configured caller identity');
    const deadline = performance.now() + 5000;
    let binding = await publishedBinding(target.lockPath, deadline);
    if (binding) assertBinding(binding, target);
    if (!binding && !options.bootstrap)
      throw new BridgeError('RUNTIME_UNAVAILABLE', 'No Bridge runtime owns this state root');
    const timeoutMs = Math.max(100, Math.min(options.timeoutMs ?? 55000, 60000));
    let bootstrapped = false;
    if ((!binding || processAbsent(binding.pid)) && options.bootstrap) {
      bootstrapped = true;
      await options.bootstrap();
    }
    for (let count = 0; count < 100 && performance.now() < deadline; count++) {
      binding = await publishedBinding(target.lockPath, deadline);
      if (binding) {
        assertBinding(binding, target);
        try {
          assertPrivate(await lstat(target.socketPath), 'socket');
          const token = await credential(target, caller);
          const bindingHash = digest(binding);
          const probe = new BridgeClient(
            target,
            callerRef,
            token,
            Math.max(1, Math.min(timeoutMs, deadline - performance.now())),
            bindingHash
          );
          await probe.dispatch('runtime.handshake');
          return new BridgeClient(target, callerRef, token, timeoutMs, bindingHash);
        } catch (error) {
          const transport =
            error instanceof BridgeError &&
            ['CONNECTION_FAILED', 'CONNECTION_CLOSED', 'CONNECTION_TIMEOUT'].includes(error.code);
          const changedBinding =
            error instanceof BridgeError &&
            error.code === 'RUNTIME_UNAVAILABLE' &&
            bootstrapped &&
            digest(await publishedBinding(target.lockPath, deadline)) !== digest(binding);
          const starting =
            error instanceof BridgeError &&
            bootstrapped &&
            ['STATE_UNSAFE', 'AUTH_REQUIRED'].includes(error.code);
          if (
            (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
            !transport &&
            !changedBinding &&
            !starting
          )
            throw error;
        }
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Math.min(50, deadline - performance.now())))
      );
    }
    throw new BridgeError(
      'RUNTIME_UNAVAILABLE',
      'Runtime did not authenticate within its startup bound'
    );
  }
  public async dispatch(operation: string, args: unknown = {}): Promise<unknown> {
    if (!OPERATIONS.has(operation))
      throw new BridgeError('INVALID_ARGUMENT', 'Unknown Bridge control operation');
    const request = signRequest(
      {
        apiVersion: 'agent-bridge/v1',
        configHash: this.target.configHash,
        callerRef: this.callerRef,
        bindingHash: this.bindingHash,
        operation,
        args
      },
      this.token
    );
    const frame = JSON.stringify(request) + '\n';
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
      throw new BridgeError('INPUT_LIMIT', 'Control request exceeds its limit');
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.target.socketPath);
      let received = Buffer.alloc(0);
      let settled = false;
      let sent = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: unknown, value?: unknown) => {
        if (settled) return;
        settled = true;
        if (deadline) clearTimeout(deadline);
        socket.destroy();
        if (error) reject(error);
        else resolve(value);
      };
      deadline = setTimeout(
        () =>
          finish(
            new BridgeError(
              'CONNECTION_TIMEOUT',
              'Bridge control response timed out; recover using the original requestId',
              sent ? 'unknown' : 'not_started'
            )
          ),
        this.timeoutMs
      );
      socket.once('connect', () => {
        sent = true;
        socket.write(frame);
      });
      socket.on('error', () =>
        finish(
          new BridgeError(
            'CONNECTION_FAILED',
            'Bridge control connection failed; recover using the original requestId',
            sent ? 'unknown' : 'not_started'
          )
        )
      );
      socket.on('close', () => {
        if (!settled)
          finish(
            new BridgeError(
              'CONNECTION_CLOSED',
              'Bridge control connection closed before a response',
              sent ? 'unknown' : 'not_started'
            )
          );
      });
      socket.on('data', (chunk: Buffer) => {
        received = Buffer.concat([received, chunk]);
        if (received.length > MAX_FRAME_BYTES) {
          finish(new BridgeError('OUTPUT_LIMIT', 'Control response exceeds its limit', 'unknown'));
          return;
        }
        const index = received.indexOf(10);
        if (index < 0) return;
        try {
          if (received.subarray(index + 1).length)
            throw new BridgeError('PROTOCOL_ERROR', 'Multiple control responses', 'unknown');
          finish(
            undefined,
            unwrapReply(
              verifyReply(
                JSON.parse(received.subarray(0, index).toString('utf8')),
                request,
                this.token
              ),
              operation,
              requestId(args)
            )
          );
        } catch (error) {
          finish(
            error instanceof BridgeError
              ? error
              : new BridgeError('PROTOCOL_ERROR', 'Malformed control response', 'unknown')
          );
        }
      });
    });
  }
  private call<T>(operation: string, args: unknown = {}): Promise<T> {
    return this.dispatch(operation, args) as Promise<T>;
  }
  public readonly engines = { list: (): Promise<EngineList> => this.call('engine.list') };
  public preflight(args: PreflightArgs): Promise<Preflight> {
    return this.call('preflight', args);
  }
  public readonly tasks = {
    start: (args: StartTaskArgs): Promise<TaskRecord> => this.call('task.start', args),
    get: (args: TaskArgs): Promise<TaskRecord> => this.call('task.get', args),
    list: (args: ListTaskArgs = {}): Promise<TaskList> => this.call('task.list', args),
    events: (args: WatchTaskArgs): Promise<TaskEvents> => this.call('task.watch', args),
    continue: (args: ContinueTaskArgs): Promise<TaskRecord> => this.call('task.continue', args),
    cancel: (args: CancelTaskArgs): Promise<TaskRecord> => this.call('task.cancel', args)
  };
  public readonly artifacts = {
    list: (args: TaskArgs): Promise<ArtifactList> => this.call('artifact.list', args),
    read: (args: ReadArtifactArgs): Promise<ArtifactPage> => this.call('artifact.read', args)
  };
}
