import { spawn } from 'node:child_process';
import type { ProjectConfig } from '../contracts/validation.js';
import type { VerificationRecord } from '../contracts/types.js';
import { BridgeError } from '../contracts/errors.js';

export function selectedVerifications(config: ProjectConfig['verifications'], ids: string[]) {
  if (new Set(config.map((item) => item.id)).size !== config.length)
    throw new BridgeError('INVALID_VERIFICATION', 'Configured verification IDs must be unique');
  return ids.map((id) => {
    const command = config.find((item) => item.id === id);
    if (!command)
      throw new BridgeError(
        'UNKNOWN_VERIFICATION',
        'Task selected an unregistered verification ID'
      );
    return command;
  });
}
export async function runVerification(
  config: ProjectConfig['verifications'][number],
  cwd: string,
  maxBytes: number,
  signal?: AbortSignal
): Promise<VerificationRecord> {
  const started = Date.now();
  if (signal?.aborted)
    return {
      id: config.id,
      command: config.command,
      args: [...config.args],
      exitCode: null,
      stdout: '',
      stderr: 'VERIFICATION_CANCELLED',
      signal: 'ABORTED',
      durationMs: 0
    };
  return new Promise((resolve) => {
    const child = spawn(config.command, config.args, {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let total = 0;
    let truncated = false;
    let timedOut = false;
    let cancelled = false;
    let stopping = false;
    let escalation: NodeJS.Timeout | undefined;
    const append = (target: 'stdout' | 'stderr', bytes: Buffer) => {
      const available = Math.max(0, maxBytes - total);
      const accepted = bytes.subarray(0, available);
      total += accepted.byteLength;
      truncated ||= accepted.byteLength < bytes.byteLength;
      if (target === 'stdout') stdout = Buffer.concat([stdout, accepted]);
      else stderr = Buffer.concat([stderr, accepted]);
    };
    child.stdout.on('data', (bytes: Buffer) => append('stdout', bytes));
    child.stderr.on('data', (bytes: Buffer) => append('stderr', bytes));
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
      }
    };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), 200);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, config.timeoutMs);
    const abort = () => {
      cancelled = true;
      stop();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.once('error', () => append('stderr', Buffer.from('\nCOMMAND_SPAWN_FAILED')));
    child.once('close', (exitCode, childSignal) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', abort);
      const suffix = `${timedOut ? '\nVERIFICATION_TIMEOUT' : ''}${cancelled ? '\nVERIFICATION_CANCELLED' : ''}${truncated ? '\nOUTPUT_TRUNCATED' : ''}`;
      resolve({
        id: config.id,
        command: config.command,
        args: [...config.args],
        exitCode,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8') + suffix,
        ...(childSignal ? { signal: childSignal } : {}),
        durationMs: Date.now() - started
      });
    });
  });
}
