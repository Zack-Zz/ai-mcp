import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { BridgeError } from '../contracts/errors.js';

const execute = promisify(execFile);
export async function git(cwd: string, args: string[], allowed = [0]): Promise<string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
  );
  try {
    return (
      await execute('git', ['--no-optional-locks', ...args], {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
      })
    ).stdout;
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (typeof failure.code === 'number' && allowed.includes(failure.code))
      return failure.stdout ?? '';
    throw new BridgeError('GIT_FAILED', 'Git workspace operation failed');
  }
}
export async function gitRoot(root: string): Promise<string> {
  try {
    return await realpath((await git(root, ['rev-parse', '--show-toplevel'])).trim());
  } catch {
    throw new BridgeError(
      'INVALID_REPOSITORY',
      'Registered repoRoot must be the actual Git working tree root'
    );
  }
}
export type GitState = {
  head: string;
  symbolicHead: string;
  refs: string;
  index: string;
  binding: string;
};
export async function gitState(root: string): Promise<GitState> {
  const marker = join(root, '.git');
  const stat = await lstat(marker);
  if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
    throw new BridgeError('WORKSPACE_ESCAPE', 'Git metadata binding must not be a symlink');
  const binding = stat.isDirectory()
    ? await realpath(marker)
    : createHash('sha256')
        .update(await readFile(marker))
        .digest('hex');
  const [head, symbolicHead, refs, index] = await Promise.all([
    git(root, ['rev-parse', '--verify', 'HEAD^{commit}']),
    git(root, ['symbolic-ref', '-q', 'HEAD'], [0, 1]),
    git(root, ['for-each-ref', '--format=%(refname) %(objectname)']),
    git(root, ['ls-files', '--stage', '-v', '-z'])
  ]);
  return { head: head.trim(), symbolicHead: symbolicHead.trim(), refs, index, binding };
}
