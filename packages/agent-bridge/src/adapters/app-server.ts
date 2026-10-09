import { realpath } from 'node:fs/promises';
import { BridgeError } from '../contracts/errors.js';
import type {
  EngineEvent,
  EngineOutcome,
  EngineRunHandle,
  JsonValue,
  LaunchInput
} from '../contracts/types.js';
import { nativeArgs } from './native.js';
import { scrub, scrubText } from './events.js';
import {
  AppServerProcess,
  NativeRpcError,
  nativeErrorDetails,
  object,
  type Frame
} from './app-server-process.js';

const uuid = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const turnEvents = new Set([
  'turn/completed',
  'item/completed',
  'item/started',
  'item/agentMessage/delta',
  'thread/tokenUsage/updated',
  'error'
]);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Persistent native root/turn execution through Codex's published stdio JSON RPC. */
export async function launchCodexAppServer(
  input: LaunchInput,
  observe: (event: EngineEvent) => void
): Promise<EngineRunHandle> {
  // Share exact launcher, continuation-ID and fail-closed permission validation with exec.
  nativeArgs('codex', input);
  if (process.platform === 'win32')
    throw new BridgeError(
      'UNSUPPORTED_CAPABILITY',
      'Owned process-group cancellation is unavailable on Windows'
    );
  if (input.signal?.aborted)
    return {
      pid: undefined,
      result: Promise.resolve({
        status: 'cancelled',
        message: 'Cancelled before launch',
        executionStopped: true,
        exitCode: null,
        executionDisposition: 'not_started'
      }),
      async interrupt() {}
    };
  const cwd = await realpath(input.cwd);
  const secrets = Object.entries({ ...process.env, ...input.config.env })
    .filter(([key]) => /key|token|password|secret|authorization|credential/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string');
  let reason: 'cancelled' | 'failed' | undefined;
  let failureMessage = 'Native app-server did not provide valid completion evidence';
  let sessionId: string | undefined;
  let turnId: string | undefined;
  let message = '';
  let usage: JsonValue | undefined;
  let validTerminal = false;
  let shutting = false;
  let settled = false;
  let queued: Frame[] = [];
  let done!: () => void;
  const terminal = new Promise<void>((resolve) => {
    done = resolve;
  });
  let transport: AppServerProcess;
  const fail = (text: string) => {
    reason ??= 'failed';
    failureMessage = text;
    done();
    transport?.rejectPending();
  };
  const emit = (kind: EngineEvent['kind'], data: unknown) => {
    try {
      observe({ kind, data: scrub(data, secrets) });
    } catch {
      fail('Native event observer failed');
    }
  };
  const reportNativeError = (
    source: 'rpc' | 'turn',
    value: unknown,
    fallback: string,
    willRetry = false
  ) => {
    const details = nativeErrorDetails(value, fallback);
    const code = typeof details.code === 'string' ? scrubText(details.code, secrets) : details.code;
    const text = scrubText(details.message, secrets);
    emit('diagnostic', {
      source,
      ...(code === undefined ? {} : { code }),
      message: text,
      willRetry
    });
    if (!willRetry)
      fail(`Native ${source} error${code === undefined ? '' : ` [${code}]`}: ${text}`);
  };
  const notification = (frame: Frame) => {
    if ('id' in frame) {
      // We have no delegated human approval authority, including for unknown future requests.
      try {
        transport.send({
          id: frame.id,
          error: {
            code: -32601,
            message: 'Bridge does not grant native request or approval authority'
          }
        });
      } catch {
        /* The connection is already closing. */
      }
      fail('Native server requested unsupported authority');
      return;
    }
    if (reason || shutting) return;
    const params = object(frame.params);
    if (!turnEvents.has(String(frame.method)) || typeof params.threadId !== 'string') return;
    if (
      (sessionId && params.threadId !== sessionId) ||
      (!sessionId && input.sessionId && params.threadId !== input.sessionId)
    )
      return;
    if (!sessionId || !turnId) {
      if (queued.length >= 256) {
        fail('Native pending-event limit exceeded');
        return;
      }
      queued.push(frame);
      return;
    }
    if (params.threadId !== sessionId) return;
    const method = frame.method;
    if (method === 'turn/completed') {
      const turn = object(params.turn);
      if (turn.id !== turnId) return;
      if (turn.status !== 'completed' || turn.error != null) {
        reportNativeError('turn', turn.error, 'Native turn did not complete');
        return;
      }
      const items = turn.items;
      if (Array.isArray(items)) for (const entry of items) acceptItem(object(entry));
      validTerminal = true;
      done();
    } else if (params.turnId === turnId) {
      if (method === 'item/completed') acceptItem(object(params.item));
      else if (method === 'thread/tokenUsage/updated') {
        usage = scrub(params.tokenUsage, secrets);
        emit('usage', usage);
      } else if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
        emit('message', { text: params.delta, partial: true });
      } else if (method === 'error')
        reportNativeError(
          'turn',
          params.error,
          'Native turn reported an error',
          params.willRetry === true
        );
      else if (method === 'item/started')
        emit('tool', { name: object(params.item).type, status: 'started' });
    }
  };
  const acceptItem = (item: Frame) => {
    if (item.type === 'agentMessage' && typeof item.text === 'string') {
      message = scrubText(item.text, secrets);
      emit('message', { text: message });
    } else if (typeof item.type === 'string')
      emit('tool', { name: item.type, status: 'completed' });
  };
  transport = new AppServerProcess(
    input,
    notification,
    (text) => emit('diagnostic', { message: text }),
    fail
  );
  const abort = () => {
    void interrupt();
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => fail('Native app-server run timed out'), input.timeoutMs);
  void transport.exited.then(() => {
    if (!shutting) fail('Native app-server exited before ordered shutdown');
  });
  const result = (async (): Promise<EngineOutcome> => {
    try {
      await transport.rpc('initialize', { clientInfo: { name: 'agent_bridge', version: '0.1.0' } });
      transport.send({ method: 'initialized', params: {} });
      const response = object(
        await transport.rpc(input.sessionId ? 'thread/resume' : 'thread/start', {
          ...(input.sessionId
            ? { threadId: input.sessionId, excludeTurns: true }
            : { ephemeral: false }),
          cwd: input.cwd,
          sandbox: input.permissionProfile
        })
      );
      const thread = object(response.thread);
      if (
        typeof thread.id !== 'string' ||
        !uuid.test(thread.id) ||
        (input.sessionId && thread.id !== input.sessionId) ||
        (thread.sessionId != null && thread.sessionId !== thread.id) ||
        thread.parentThreadId != null ||
        thread.forkedFromId != null ||
        thread.ephemeral === true ||
        object(thread.status).type !== 'idle' ||
        typeof thread.cwd !== 'string' ||
        (await realpath(thread.cwd)) !== cwd
      )
        throw new Error('Native root/session/cwd mismatch or busy thread');
      sessionId = thread.id;
      emit('session', { sessionId });
      if (reason) throw new Error('Observer failed');
      const started = object(
        await transport.rpc('turn/start', {
          threadId: sessionId,
          input: [{ type: 'text', text: input.prompt, text_elements: [] }]
        })
      );
      const turn = object(started.turn);
      if (
        typeof turn.id !== 'string' ||
        !turn.id ||
        !['inProgress', 'completed'].includes(String(turn.status))
      )
        throw new Error('Invalid native turn/start response');
      turnId = turn.id;
      const pending = queued;
      queued = [];
      for (const frame of pending) notification(frame);
      await terminal;
    } catch (error) {
      if (!reason) {
        if (error instanceof NativeRpcError)
          reportNativeError(
            'rpc',
            { code: error.code, message: error.message },
            'Native RPC rejected the request'
          );
        else fail('Native RPC or root/turn binding failed');
      }
    } finally {
      shutting = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
    }
    const exit = await transport.shutdown();
    const completed =
      !reason &&
      validTerminal &&
      !exit.forced &&
      !transport.spawnFailed &&
      exit.exitCode === 0 &&
      exit.signal === null &&
      exit.executionStopped &&
      !!sessionId;
    settled = true;
    return {
      status: completed
        ? 'completed'
        : reason === 'cancelled' && exit.executionStopped
          ? 'cancelled'
          : 'failed',
      message: completed
        ? message
        : !exit.executionStopped
          ? 'Native execution stop could not be confirmed'
          : reason === 'cancelled'
            ? 'Run cancelled'
            : exit.forced
              ? 'Native app-server required forced process-group cleanup'
              : scrubText(failureMessage, secrets),
      exitCode: exit.exitCode,
      signal: exit.signal,
      processGroupExited: exit.processGroupExited,
      executionStopped: exit.executionStopped,
      executionDisposition: completed
        ? 'completed'
        : transport.spawnFailed
          ? 'not_started'
          : 'unknown',
      ...(sessionId ? { sessionId } : {}),
      ...(usage ? { usage } : {})
    };
  })();
  let interrupting: Promise<void> | undefined;
  function interrupt(): Promise<void> {
    return (interrupting ??= performInterrupt());
  }
  async function performInterrupt(): Promise<void> {
    if (settled || shutting) {
      await result;
      return;
    }
    reason = 'cancelled';
    if (sessionId && turnId) {
      // One attempt only; connection shutdown rejects this RPC if the server cannot answer.
      await Promise.race([
        transport.rpc('turn/interrupt', { threadId: sessionId, turnId }).catch(() => {}),
        delay(100)
      ]);
    }
    done();
    transport.rejectPending();
    await result;
  }
  if (input.signal?.aborted) abort();
  return { pid: transport.child.pid, result, interrupt };
}
