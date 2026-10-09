import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { LaunchInput } from '../contracts/types.js';
import { nativeEnvironment } from './environment.js';

export type Frame = Record<string, unknown>;
export const object = (value: unknown): Frame =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Frame) : {};
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export type ProcessExit = { exitCode: number | null; signal: NodeJS.Signals | null };

export function nativeErrorDetails(
  value: unknown,
  fallback: string
): { code?: string | number; message: string } {
  const error = object(value);
  const code = error.code ?? error.codexErrorInfo;
  return {
    ...(typeof code === 'string' || (typeof code === 'number' && Number.isFinite(code))
      ? { code }
      : {}),
    message: typeof error.message === 'string' ? error.message : fallback
  };
}

/** Only public scalar code/message survive the native RPC boundary, never error.data. */
export class NativeRpcError extends Error {
  readonly code: string | number | undefined;
  constructor(value: unknown) {
    const details = nativeErrorDetails(value, 'Native RPC rejected the request');
    super(details.message);
    this.code = details.code;
  }
}

/** One private stdio RPC connection and the process group created by this spawn. */
export class AppServerProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exited: Promise<ProcessExit>;
  private readonly drained: Promise<void>;
  spawnFailed = false;
  private leaderExited = false;
  private groupGone = false;
  private ownershipTrusted = true;
  private ending = false;
  private counter = 0;
  private bytes = 0;
  private output = '';
  private errorOutput = '';
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true });
  private readonly stderrUtf8 = new TextDecoder('utf-8', { fatal: true });
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();

  constructor(
    input: LaunchInput,
    private readonly notification: (frame: Frame) => void,
    private readonly diagnostic: (text: string) => void,
    private readonly failure: (message: string) => void
  ) {
    this.child = spawn(
      input.config.command,
      [...input.config.args, 'app-server', '--listen', 'stdio://'],
      {
        cwd: input.cwd,
        env: nativeEnvironment(input.config),
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe']
      }
    );
    this.drained = new Promise((resolve) => this.child.once('close', () => resolve()));
    this.exited = new Promise((resolve) => {
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        this.leaderExited = true;
        this.groupExited();
        this.rejectPending();
        resolve({ exitCode, signal });
      };
      this.child.once('exit', finish);
      this.child.once('close', (code, signal) => {
        if (!this.leaderExited) finish(code, signal);
      });
    });
    this.child.on('error', () => {
      this.spawnFailed = true;
      this.failure('Native app-server could not start');
    });
    this.child.stdin.on('error', () => {
      if (!this.ending) this.failure('Native RPC input closed unexpectedly');
    });
    const account = (chunk: Buffer): boolean => {
      this.bytes += chunk.byteLength;
      if (this.bytes > input.maxLogBytes) {
        this.failure('Native output exceeded the log limit');
        return false;
      }
      return true;
    };
    this.child.stdout.on('data', (chunk: Buffer) => {
      if (!account(chunk)) return;
      try {
        this.output += this.utf8.decode(chunk, { stream: true });
        if (Buffer.byteLength(this.output) > 4 * 1024 * 1024) throw new Error();
        let index: number;
        while ((index = this.output.indexOf('\n')) >= 0) {
          const line = this.output.slice(0, index);
          this.output = this.output.slice(index + 1);
          if (!line.trim()) continue;
          const value: unknown = JSON.parse(line);
          const frame = object(value);
          if (!Object.keys(frame).length) throw new Error();
          this.receive(frame);
        }
      } catch {
        this.failure('Invalid native JSON/UTF8 RPC frame');
      }
    });
    this.child.stderr.on('data', (chunk: Buffer) => {
      if (!account(chunk)) return;
      try {
        this.errorOutput += this.stderrUtf8.decode(chunk, { stream: true });
        let index: number;
        while ((index = this.errorOutput.indexOf('\n')) >= 0) {
          this.diagnostic(this.errorOutput.slice(0, index));
          this.errorOutput = this.errorOutput.slice(index + 1);
        }
      } catch {
        this.failure('Invalid native diagnostic UTF8');
      }
    });
    this.child.stdout.on('end', () => {
      try {
        const tail = this.output + this.utf8.decode();
        // JSON-lines transport requires complete newline-terminated frames.
        if (tail.trim()) this.failure('Truncated native RPC frame');
      } catch {
        this.failure('Truncated native RPC UTF8');
      }
    });
    this.child.stderr.on('end', () => {
      try {
        const tail = this.errorOutput + this.stderrUtf8.decode();
        if (tail) this.diagnostic(tail);
      } catch {
        this.failure('Truncated native diagnostic UTF8');
      }
    });
  }

  private receive(frame: Frame): void {
    if (typeof frame.method === 'string') {
      this.notification(frame);
      return;
    }
    const pending = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
    if (!pending || 'error' in frame === 'result' in frame) {
      this.failure('Uncorrelated or invalid native RPC response');
      return;
    }
    this.pending.delete(frame.id as number);
    if ('error' in frame) pending.reject(new NativeRpcError(frame.error));
    else pending.resolve(frame.result);
  }

  send(frame: Frame): void {
    if (this.ending || this.leaderExited || !this.child.stdin.writable)
      throw new Error('Native RPC unavailable');
    const line = JSON.stringify(frame) + '\n';
    if (Buffer.byteLength(line) > 4 * 1024 * 1024)
      throw new Error('Native RPC request exceeds frame limit');
    this.child.stdin.write(line, (error) => {
      if (error && !this.ending) this.failure('Native RPC write failed');
    });
  }

  rpc(method: string, params: Frame): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.counter;
      this.pending.set(id, { resolve, reject });
      try {
        this.send({ id, method, params });
      } catch {
        this.pending.delete(id);
        reject(new Error('Native RPC unavailable'));
      }
    });
  }

  rejectPending(): void {
    for (const entry of this.pending.values()) entry.reject(new Error('Native RPC stopped'));
    this.pending.clear();
  }

  groupExited(): boolean {
    if (this.groupGone || !this.child.pid) return true;
    try {
      process.kill(-this.child.pid, 0);
      return false;
    } catch (error) {
      this.groupGone = (error as NodeJS.ErrnoException).code === 'ESRCH';
      return this.groupGone;
    }
  }

  private signal(signal: NodeJS.Signals): boolean {
    if (!this.child.pid || this.groupExited()) return true;
    if (this.leaderExited) {
      // A reaped leader PID must remain absent. Never signal a possibly reused group.
      try {
        process.kill(this.child.pid, 0);
        this.ownershipTrusted = false;
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          this.ownershipTrusted = false;
          return false;
        }
      }
    }
    try {
      process.kill(-this.child.pid, signal);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  private async awaitGroup(ms: number): Promise<boolean> {
    for (let elapsed = 0; elapsed < ms; elapsed += 20) {
      if (this.groupExited()) return true;
      await delay(20);
    }
    return this.groupExited();
  }

  async shutdown(): Promise<
    ProcessExit & { processGroupExited: boolean; executionStopped: boolean; forced: boolean }
  > {
    this.ending = true;
    this.rejectPending();
    this.child.stdin.end();
    let forced = false;
    if (!(await this.awaitGroup(160))) {
      if (!this.signal('SIGINT') || !(await this.awaitGroup(400))) {
        forced = true;
        this.signal('SIGTERM');
        if (!(await this.awaitGroup(160))) {
          this.signal('SIGKILL');
          await this.awaitGroup(800);
        }
      }
    }
    const exit = await Promise.race([
      this.exited,
      delay(200).then(() => ({ exitCode: null, signal: null }))
    ]);
    const drained = await Promise.race([
      this.drained.then(() => true),
      delay(200).then(() => false)
    ]);
    if (!drained) {
      this.failure('Native RPC output did not drain after shutdown');
      // Release only our pipe handles; an escaped process is not authority to kill another group.
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
    const processGroupExited = this.groupExited();
    return {
      ...exit,
      processGroupExited,
      // Destroying local pipes after the drain deadline does not prove the writer stopped.
      executionStopped: this.leaderExited && processGroupExited && drained && this.ownershipTrusted,
      forced
    };
  }
}
