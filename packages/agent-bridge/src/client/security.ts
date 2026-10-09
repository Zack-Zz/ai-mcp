import { constants, type Stats } from 'node:fs';
import { open, mkdir, lstat, realpath, unlink, rename, readdir, rmdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BridgeConfig, Caller } from '../contracts/validation.js';
import { BridgeError } from '../contracts/errors.js';
import { digest } from '../runtime/journal.js';

const execute = promisify(execFile);
export type RuntimeBinding = {
  schemaVersion: 1;
  pid: number;
  processStartIdentity: string;
  configHash: string;
  stateRoot: string;
  nonce: string;
};
export type Endpoint = {
  stateRoot: string;
  socketDirectory: string;
  socketPath: string;
  lockPath: string;
  configHash: string;
};
export function assertPrivate(stat: Stats, kind: 'file' | 'directory' | 'socket'): void {
  const correct =
    kind === 'directory'
      ? stat.isDirectory()
      : kind === 'socket'
        ? stat.isSocket()
        : stat.isFile() && stat.nlink === 1;
  if (
    !correct ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BridgeError(
      'STATE_UNSAFE',
      'Bridge state must be private and owned by the current user'
    );
}
export async function privateDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  assertPrivate(await lstat(path), 'directory');
  return realpath(path);
}
export async function readPrivate(path: string): Promise<string> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP')
      throw new BridgeError('STATE_UNSAFE', 'Bridge state symlink rejected');
    throw error;
  }
  try {
    assertPrivate(await file.stat(), 'file');
    const stat = await file.stat();
    if (stat.size > 4 * 1024 * 1024)
      throw new BridgeError('STATE_UNSAFE', 'Bridge state file exceeds its limit');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
export async function writeExclusive(path: string, content: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  );
  try {
    assertPrivate(await file.stat(), 'file');
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
}
export async function endpoint(config: BridgeConfig): Promise<Endpoint> {
  const stateRoot = await privateDirectory(config.stateRoot);
  const rootHash = createHash('sha256').update(stateRoot).digest('hex').slice(0, 24);
  const socketDirectory = await privateDirectory(
    join(
      process.platform === 'darwin' ? '/private/tmp' : tmpdir(),
      `agent-bridge-${process.getuid?.() ?? 'user'}-${rootHash}`
    )
  );
  return {
    stateRoot,
    socketDirectory,
    socketPath: join(socketDirectory, 'runtime.sock'),
    lockPath: join(stateRoot, 'runtime.lock.json'),
    configHash: digest({ ...config, stateRoot })
  };
}
export async function processIdentity(pid: number): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const result = await execute('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'comm='], {
      timeout: 2000,
      maxBuffer: 4096,
      env: { ...process.env, LC_ALL: 'C' }
    });
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}
export function processAbsent(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}
export async function readBinding(path: string): Promise<RuntimeBinding | null> {
  let raw: string;
  try {
    raw = await readPrivate(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BridgeError('STATE_CORRUPT', 'Invalid runtime binding');
  }
  const binding = value as Partial<RuntimeBinding> | null;
  if (
    !binding ||
    binding.schemaVersion !== 1 ||
    !Number.isSafeInteger(binding.pid) ||
    !binding.pid ||
    binding.pid <= 0 ||
    typeof binding.processStartIdentity !== 'string' ||
    !binding.processStartIdentity ||
    typeof binding.stateRoot !== 'string' ||
    typeof binding.configHash !== 'string' ||
    typeof binding.nonce !== 'string'
  )
    throw new BridgeError('STATE_CORRUPT', 'Invalid runtime binding');
  return binding as RuntimeBinding;
}
export function assertBinding(binding: RuntimeBinding, target: Endpoint): void {
  if (binding.stateRoot !== target.stateRoot || binding.configHash !== target.configHash)
    throw new BridgeError(
      'CONFIG_MISMATCH',
      'Existing runtime is bound to a different configuration'
    );
}
async function claimRecovery(
  target: Endpoint,
  binding: RuntimeBinding
): Promise<() => Promise<void>> {
  const recovery = `${target.lockPath}.recovery`;
  const candidate = `${recovery}-${binding.nonce}.candidate`;
  const ownerName = `owner-${binding.nonce}.json`;
  await mkdir(candidate, { mode: 0o700 });
  await writeExclusive(join(candidate, ownerName), JSON.stringify(binding));
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        // Publishing a populated directory is atomic. An existing populated owner cannot be replaced.
        await rename(candidate, recovery);
        return async () => {
          const stat = await lstat(recovery);
          assertPrivate(stat, 'directory');
          await unlink(join(recovery, ownerName)).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
          await rmdir(recovery).catch((error) => {
            if (
              !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(
                (error as NodeJS.ErrnoException).code ?? ''
              )
            )
              throw error;
          });
        };
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'ENOTDIR', 'EISDIR'].includes(
            (error as NodeJS.ErrnoException).code ?? ''
          )
        )
          throw error;
      }
      let stat;
      try {
        stat = await lstat(recovery);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (stat.isDirectory()) {
        assertPrivate(stat, 'directory');
        const names = await readdir(recovery);
        if (!names.length) continue;
        if (names.length !== 1 || !/^owner-[a-f0-9]{48}\.json$/.test(names[0]!))
          throw new BridgeError('STATE_UNSAFE', 'Recovery directory contains unknown state');
        const owner = await readBinding(join(recovery, names[0]!));
        if (!owner) continue;
        assertBinding(owner, target);
        if (names[0] !== `owner-${owner.nonce}.json`)
          throw new BridgeError('STATE_CORRUPT', 'Recovery owner identity differs from its file');
        if (!processAbsent(owner.pid))
          throw new BridgeError('RUNTIME_BUSY', 'Another live process owns runtime recovery');
        // Delete only the old nonce. A newly published owner's different file is preserved.
        await unlink(join(recovery, names[0]!)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        await rmdir(recovery).catch((error) => {
          if (
            !['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')
          )
            throw error;
        });
      } else {
        assertPrivate(stat, 'file');
        const owner = await readBinding(recovery);
        if (!owner) continue;
        assertBinding(owner, target);
        if (!processAbsent(owner.pid))
          throw new BridgeError('RUNTIME_BUSY', 'Another live process owns runtime recovery');
        // Earlier candidates used a file. unlink cannot remove a concurrently published directory.
        await unlink(recovery).catch((error) => {
          if (!['ENOENT', 'EISDIR', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
        });
      }
    }
    throw new BridgeError('RUNTIME_BUSY', 'Runtime recovery ownership changed concurrently');
  } finally {
    await unlink(join(candidate, ownerName)).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
    await rmdir(candidate).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}
export async function claimRuntime(target: Endpoint): Promise<RuntimeBinding> {
  const identity = await processIdentity(process.pid);
  if (!identity)
    throw new BridgeError('RUNTIME_UNAVAILABLE', 'Cannot establish runtime process-start identity');
  const binding: RuntimeBinding = {
    schemaVersion: 1,
    pid: process.pid,
    processStartIdentity: identity,
    stateRoot: target.stateRoot,
    configHash: target.configHash,
    nonce: randomBytes(24).toString('hex')
  };
  try {
    await writeExclusive(target.lockPath, JSON.stringify(binding));
    return binding;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const old = await readBinding(target.lockPath);
  if (!old) return claimRuntime(target);
  assertBinding(old, target);
  if (!processAbsent(old.pid))
    throw new BridgeError('RUNTIME_BUSY', 'A runtime process still owns this state root');
  // Only a confirmed absent PID with the exact root/config binding can be recovered.
  const releaseRecovery = await claimRecovery(target, binding);
  try {
    const again = await readBinding(target.lockPath);
    if (again?.nonce !== old.nonce || !processAbsent(again.pid))
      throw new BridgeError('RUNTIME_BUSY', 'Runtime binding changed during recovery');
    await unlink(target.lockPath);
    return await claimRuntime(target);
  } finally {
    await releaseRecovery();
  }
}
export async function releaseRuntime(target: Endpoint, binding: RuntimeBinding): Promise<void> {
  const current = await readBinding(target.lockPath);
  if (current?.nonce === binding.nonce) await unlink(target.lockPath);
}
export async function credential(
  target: Endpoint,
  caller: Caller,
  create = false
): Promise<string> {
  const directory = await privateDirectory(join(target.stateRoot, 'clients'));
  const path = join(directory, `${caller.id}.token`);
  const callerHash = digest(caller);
  let raw: string;
  try {
    raw = await readPrivate(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create)
      throw new BridgeError('AUTH_REQUIRED', 'Configured client credential is unavailable');
    const token = randomBytes(32).toString('hex');
    await writeExclusive(path, JSON.stringify({ callerHash, token }));
    return token;
  }
  const value = JSON.parse(raw) as { callerHash?: unknown; token?: unknown };
  if (
    value.callerHash !== callerHash ||
    typeof value.token !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.token)
  )
    throw new BridgeError('AUTH_REQUIRED', 'Credential does not match configured client identity');
  return value.token;
}
