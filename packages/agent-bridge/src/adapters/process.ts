import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { BridgeError } from '../contracts/errors.js';
import type {
  EngineEvent,
  EngineOutcome,
  EngineRunHandle,
  LaunchInput
} from '../contracts/types.js';
import type { EngineId } from '../contracts/validation.js';
import { EventDecoder } from './events.js';
import { nativeArgs } from './native.js';
import { nativeEnvironment } from './environment.js';

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export async function launchProcess(
  engine: EngineId,
  input: LaunchInput,
  observe: (event: EngineEvent) => void
): Promise<EngineRunHandle> {
  const args = nativeArgs(engine, input);
  if (input.signal?.aborted)
    return {
      pid: undefined,
      result: Promise.resolve({
        status: 'cancelled',
        message: 'Cancelled before launch',
        exitCode: null,
        executionDisposition: 'not_started'
      }),
      async interrupt() {}
    };
  if (process.platform === 'win32')
    throw new BridgeError(
      'UNSUPPORTED_CAPABILITY',
      'Owned process-group cancellation has not been verified on Windows'
    );
  const secrets = Object.entries({ ...process.env, ...input.config.env })
    .filter(([key]) => /key|token|password|secret|authorization|credential/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string');
  const decoder = new EventDecoder(engine, input.sessionId, secrets, observe);
  const child = spawn(input.config.command, [...input.config.args, ...args], {
    cwd: input.cwd,
    env: nativeEnvironment(input.config),
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let reason: 'cancelled' | 'timeout' | 'log-limit' | 'process-tree' | undefined;
  let stopping: Promise<void> | undefined;
  let closed = false;
  let leaderExited = false;
  child.once('exit', () => {
    leaderExited = true;
    groupExited();
  });
  let bytes = 0;
  let stdout = '';
  let stderr = '';
  let groupExitConfirmed = false;
  const groupExited = (): boolean => {
    if (groupExitConfirmed || !child.pid) return true;
    try {
      process.kill(-child.pid, 0);
      return false;
    } catch (error) {
      groupExitConfirmed = (error as NodeJS.ErrnoException).code === 'ESRCH';
      return groupExitConfirmed;
    }
  };
  const awaitGroup = async (attempts: number): Promise<boolean> => {
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (groupExited()) return true;
      await delay(25);
    }
    return groupExited();
  };
  const outUtf8 = new StringDecoder('utf8');
  const errUtf8 = new StringDecoder('utf8');
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid || groupExited()) return;
    // Once the ChildProcess has reaped its leader, an occupied numeric PID is a different process.
    if (leaderExited) {
      try {
        process.kill(child.pid, 0);
        decoder.emit('diagnostic', {
          message: 'Refusing to signal an unverified or reused process-group leader'
        });
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
    }
    try {
      process.kill(-child.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        decoder.emit('diagnostic', { message: 'Unable to signal owned process group' });
    }
  };
  const stop = (why: typeof reason): Promise<void> => {
    if (closed && !stopping && groupExited()) return Promise.resolve();
    reason ??= why;
    stopping ??= (async () => {
      signalGroup('SIGINT');
      if (await awaitGroup(6)) return;
      signalGroup('SIGTERM');
      if (await awaitGroup(6)) return;
      signalGroup('SIGKILL');
    })();
    return stopping;
  };
  const abort = () => {
    void stop('cancelled');
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    void stop('timeout');
  }, input.timeoutMs);
  const account = (chunk: Buffer): boolean => {
    bytes += chunk.byteLength;
    if (bytes > input.maxLogBytes) {
      void stop('log-limit');
      return false;
    }
    return !reason;
  };
  child.stdout.on('data', (chunk: Buffer) => {
    if (!account(chunk)) return;
    stdout += outUtf8.write(chunk);
    let index: number;
    while ((index = stdout.indexOf('\n')) >= 0) {
      decoder.parse(stdout.slice(0, index));
      stdout = stdout.slice(index + 1);
    }
  });
  child.stderr.on('data', (chunk: Buffer) => {
    if (!account(chunk)) return;
    stderr += errUtf8.write(chunk);
    let index: number;
    while ((index = stderr.indexOf('\n')) >= 0) {
      decoder.emit('diagnostic', { message: stderr.slice(0, index) });
      stderr = stderr.slice(index + 1);
    }
  });
  let spawnFailed = false;
  child.on('error', () => {
    spawnFailed = true;
  });
  const result = new Promise<EngineOutcome>((resolve) => {
    child.once('close', (exitCode, signal) => {
      closed = true;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      groupExited();
      if (!reason) {
        decoder.parse(stdout + outUtf8.end());
        const tail = stderr + errUtf8.end();
        if (tail) decoder.emit('diagnostic', { message: tail });
      }
      void (async () => {
        await stopping;
        if (!(await awaitGroup(20))) await stop(reason ?? 'process-tree');
        const processGroupExited = await awaitGroup(40);
        const completed =
          processGroupExited &&
          !reason &&
          !spawnFailed &&
          exitCode === 0 &&
          signal === null &&
          decoder.terminal &&
          !decoder.failed &&
          !decoder.invalid &&
          !!decoder.sessionId;
        const message = completed
          ? decoder.message
          : spawnFailed
            ? 'Engine executable could not start'
            : !processGroupExited
              ? 'Owned process-group exit could not be confirmed'
              : reason === 'process-tree'
                ? 'Native leader exited while a background descendant remained active'
                : reason === 'cancelled'
                  ? 'Run cancelled'
                  : reason === 'timeout'
                    ? 'Run timed out'
                    : reason === 'log-limit'
                      ? 'Native output exceeded the log limit'
                      : 'Native run failed or did not provide valid terminal/session evidence';
        resolve({
          status: completed
            ? 'completed'
            : reason === 'cancelled' && processGroupExited
              ? 'cancelled'
              : 'failed',
          message,
          exitCode,
          signal,
          processGroupExited,
          executionDisposition: completed ? 'completed' : spawnFailed ? 'not_started' : 'unknown',
          ...(decoder.sessionId ? { sessionId: decoder.sessionId } : {}),
          ...(decoder.usage ? { usage: decoder.usage } : {})
        });
      })();
    });
  });
  if (input.signal?.aborted) abort();
  return {
    pid: child.pid,
    result,
    async interrupt() {
      await stop('cancelled');
      await result;
    }
  };
}
