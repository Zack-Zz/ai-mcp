import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BridgeError } from '../contracts/errors.js';

export function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}
export function identity(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value) || value === '.' || value === '..')
    throw new BridgeError('INVALID_ARGUMENT', 'Unsafe workspace identity');
  return value;
}
export async function directory(path: string, code = 'WORKSPACE_ESCAPE'): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await lstat(canonical)).isDirectory()) throw new Error();
  } catch {
    throw new BridgeError(code, 'Expected an existing authorized directory');
  }
  return canonical;
}
export async function location(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await location(parent), relative(parent, path));
  }
}
export async function stateDirectory(root: string, ...parts: string[]): Promise<string> {
  const canonical = await location(resolve(root));
  const original = await lstat(root).catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  });
  if (original?.isSymbolicLink())
    throw new BridgeError('STATE_UNSAFE', 'State root cannot be a symlink');
  await mkdir(canonical, { recursive: true, mode: 0o700 });
  let current = canonical;
  for (const part of parts) {
    if (!part || part === '.' || part === '..' || part.includes('/') || part.includes('\\'))
      throw new BridgeError('STATE_UNSAFE', 'Unsafe state directory member');
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new BridgeError('STATE_UNSAFE', 'State directory must not follow links');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(current, { mode: 0o700 });
    }
  }
  return current;
}
export async function unsafeAncestor(root: string, path: string): Promise<string | undefined> {
  if (!inside(root, path)) return relative(root, path);
  const pieces = relative(root, dirname(path)).split(sep).filter(Boolean);
  let current = root;
  for (const piece of pieces) {
    current = join(current, piece);
    try {
      if ((await lstat(current)).isSymbolicLink()) return relative(root, current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return relative(root, current);
      throw error;
    }
  }
  return undefined;
}
