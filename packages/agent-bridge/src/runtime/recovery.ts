import type { RunRecord } from '../contracts/types.js';
import { BridgeError } from '../contracts/errors.js';
import { processAbsent, processIdentity } from '../client/security.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

function groupAbsent(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
/** Never signal a PID using its number alone, or infer death from an unavailable ps. */
export async function confirmStopped(run: RunRecord | undefined, cancel = false): Promise<void> {
  if (
    run?.outcome?.executionStopped === false ||
    (run?.terminationProofRequired === true && run.outcome?.executionStopped !== true)
  )
    throw new BridgeError(
      'EXECUTION_UNKNOWN',
      'Native execution stop is unconfirmed; leader/group absence cannot clear its workspace lease',
      'unknown'
    );
  if (run?.outcome?.executionDisposition === 'not_started') return;
  if (!run?.pid || !Number.isSafeInteger(run.pid) || run.pid <= 0)
    throw new BridgeError(
      'EXECUTION_UNKNOWN',
      'Previous launch has no verifiable process binding',
      'unknown'
    );
  if (processAbsent(run.pid) && groupAbsent(run.pid)) return;
  const identity = await processIdentity(run.pid);
  if (!cancel || !run.processStartIdentity || identity !== run.processStartIdentity)
    throw new BridgeError(
      'EXECUTION_UNKNOWN',
      'Previous process or its group is still present; exact owned identity is required',
      'unknown'
    );
  let group: number;
  try {
    group = Number(
      (
        await execute('/bin/ps', ['-p', String(run.pid), '-o', 'pgid='], {
          timeout: 2000,
          maxBuffer: 128
        })
      ).stdout.trim()
    );
  } catch {
    throw new BridgeError(
      'EXECUTION_UNKNOWN',
      'Owned process-group identity cannot be verified',
      'unknown'
    );
  }
  if (group !== run.pid)
    throw new BridgeError(
      'EXECUTION_UNKNOWN',
      'Previous process was not the independently owned group leader',
      'unknown'
    );
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    // Recheck the leader before each signal so a reused PID is never targeted.
    if ((await processIdentity(run.pid)) !== run.processStartIdentity)
      throw new BridgeError(
        'EXECUTION_UNKNOWN',
        'Process identity changed during cancellation',
        'unknown'
      );
    try {
      process.kill(-run.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
        throw new BridgeError(
          'EXECUTION_UNKNOWN',
          'Unable to stop the owned process group',
          'unknown'
        );
    }
    for (let attempt = 0; attempt < 20; attempt++) {
      if (processAbsent(run.pid) && groupAbsent(run.pid)) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new BridgeError(
    'EXECUTION_UNKNOWN',
    'Owned process-group exit could not be confirmed',
    'unknown'
  );
}
