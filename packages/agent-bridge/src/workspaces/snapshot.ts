import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  symlink
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ProjectConfig, TaskSpec } from '../contracts/validation.js';
import { BridgeError } from '../contracts/errors.js';
import { atomicWrite, assertOwnedFile, canonical, digest } from '../runtime/journal.js';
import { git, gitState, type GitState } from './git.js';
import { inside, stateDirectory, unsafeAncestor } from './paths.js';

export type Entry = {
  path: string;
  kind: 'file' | 'symlink' | 'blocked';
  mode: number;
  sha256: string;
  size: number;
  linkTarget?: string;
  blockedBy?: string;
};
export type Snapshot = {
  snapshotId: string;
  projectId: string;
  workspaceRoot: string;
  workingDirectory: string;
  repoRoot: string;
  git: GitState;
  entries: Entry[];
  permissionProfile: ProjectConfig['permissionProfile'];
  verifications: ProjectConfig['verifications'];
  taskSpec: TaskSpec;
};
export type Change = {
  path: string;
  type: 'added' | 'deleted' | 'modified';
  before?: Entry;
  after?: Entry;
};
export function hashBytes(bytes: Uint8Array | string) {
  return createHash('sha256').update(bytes).digest('hex');
}
export function snapshotBody(snapshot: Snapshot) {
  return Object.fromEntries(Object.entries(snapshot).filter(([key]) => key !== 'snapshotId'));
}

async function treeInventory(root: string): Promise<string[]> {
  const names: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const name of await readdir(directory)) {
      const path = join(directory, name);
      const stat = await lstat(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) await walk(path);
      else names.push(relative(root, path).split(sep).join('/'));
    }
  };
  await walk(root);
  return names.sort();
}

async function captureEntry(root: string, path: string, tree: string): Promise<Entry | undefined> {
  const source = join(root, path);
  const destination = join(tree, path);
  if (!inside(root, source) || path.split('/').includes('.git'))
    throw new BridgeError('WORKSPACE_ESCAPE', 'Git inventory escaped the workspace');
  const blockedBy = await unsafeAncestor(root, source);
  if (blockedBy)
    return { path, kind: 'blocked', mode: 0, sha256: digest({ blockedBy }), size: 0, blockedBy };
  const stat = await lstat(source).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  });
  if (!stat) return undefined;
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  if (stat.isSymbolicLink()) {
    const linkTarget = await readlink(source);
    await symlink(linkTarget, destination);
    return {
      path,
      kind: 'symlink',
      mode: stat.mode & 0o777,
      sha256: hashBytes(linkTarget),
      size: Buffer.byteLength(linkTarget),
      linkTarget
    };
  }
  if (!stat.isFile())
    throw new BridgeError(
      'UNSUPPORTED_WORKSPACE_ENTRY',
      'Snapshot requires regular files or symlink entries; submodules and special files are not supported'
    );
  await copyFile(source, destination);
  await chmod(destination, stat.mode & 0o777);
  const after = await lstat(source);
  if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs || stat.ino !== after.ino)
    throw new BridgeError(
      'WORKSPACE_CHANGED',
      'Workspace changed during snapshot; preserve evidence and retry inspection'
    );
  const bytes = await readFile(destination);
  return {
    path,
    kind: 'file',
    mode: stat.mode & 0o777,
    sha256: hashBytes(bytes),
    size: bytes.byteLength
  };
}
export async function captureSnapshot(
  taskRoot: string,
  root: string,
  workingDirectory: string,
  repoRoot: string,
  project: Pick<ProjectConfig, 'id' | 'permissionProfile' | 'verifications'>,
  spec: TaskSpec
): Promise<Snapshot> {
  const snapshots = await stateDirectory(taskRoot, 'snapshots');
  const temporary = await stateDirectory(snapshots, `pending-${randomUUID()}`);
  const tree = await stateDirectory(temporary, 'tree');
  const before = await gitState(root);
  const names = [
    ...new Set(
      (await git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']))
        .split('\0')
        .filter(Boolean)
    )
  ].sort();
  const entries: Entry[] = [];
  for (const path of names) {
    const entry = await captureEntry(root, path, tree);
    if (entry) entries.push(entry);
  }
  const after = await gitState(root);
  if (canonical(before) !== canonical(after))
    throw new BridgeError('WORKSPACE_CHANGED', 'Git metadata changed during snapshot');
  const body = {
    projectId: project.id,
    workspaceRoot: root,
    workingDirectory,
    repoRoot,
    git: after,
    entries,
    permissionProfile: project.permissionProfile,
    verifications: project.verifications,
    taskSpec: spec
  };
  const snapshot = { snapshotId: digest(body), ...body };
  await atomicWrite(join(temporary, 'snapshot.json'), canonical(snapshot) + '\n');
  const destination = join(snapshots, snapshot.snapshotId);
  try {
    await rename(temporary, destination);
  } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    await verifySnapshot(taskRoot, snapshot);
    await rm(temporary, { recursive: true });
  }
  return snapshot;
}
export async function verifySnapshot(taskRoot: string, snapshot: Snapshot): Promise<void> {
  if (digest(snapshotBody(snapshot)) !== snapshot.snapshotId)
    throw new BridgeError(
      'BASELINE_CORRUPT',
      'Snapshot manifest hash does not match its immutable identity'
    );
  const snapshotRoot = await stateDirectory(taskRoot, 'snapshots', snapshot.snapshotId);
  const manifest = join(snapshotRoot, 'snapshot.json');
  await assertOwnedFile(manifest);
  try {
    if (canonical(JSON.parse(await readFile(manifest, 'utf8'))) !== canonical(snapshot))
      throw new Error();
  } catch {
    throw new BridgeError(
      'BASELINE_CORRUPT',
      'Saved snapshot manifest no longer matches its immutable identity'
    );
  }
  const tree = join(snapshotRoot, 'tree');
  if ((await unsafeAncestor(taskRoot, tree)) || (await lstat(tree)).isSymbolicLink())
    throw new BridgeError('STATE_UNSAFE', 'Snapshot tree must not follow links');
  if (
    canonical(await treeInventory(tree)) !==
    canonical(
      snapshot.entries
        .filter((entry) => entry.kind !== 'blocked')
        .map((entry) => entry.path)
        .sort()
    )
  )
    throw new BridgeError(
      'BASELINE_CORRUPT',
      'Snapshot tree contains missing or unmanifested entries'
    );
  for (const entry of snapshot.entries) {
    const path = resolve(tree, entry.path);
    if (entry.kind === 'blocked') continue;
    if (!inside(tree, path) || (await unsafeAncestor(tree, path)))
      throw new BridgeError('BASELINE_CORRUPT', 'Snapshot entry escaped the immutable tree');
    const stat = await lstat(path);
    const bytes =
      entry.kind === 'symlink' && stat.isSymbolicLink()
        ? await readlink(path)
        : entry.kind === 'file' && stat.isFile()
          ? await readFile(path)
          : null;
    if (bytes === null || hashBytes(bytes) !== entry.sha256 || (stat.mode & 0o777) !== entry.mode)
      throw new BridgeError('BASELINE_CORRUPT', 'Snapshot file bytes or mode changed');
  }
}
export async function readBaseline(taskRoot: string, id: string): Promise<Snapshot> {
  const path = join(taskRoot, 'baseline.json');
  await assertOwnedFile(path);
  const snapshot = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
  if (snapshot.snapshotId !== id)
    throw new BridgeError(
      'BASELINE_CORRUPT',
      'Task baseline identity does not match the saved manifest'
    );
  await verifySnapshot(taskRoot, snapshot);
  return snapshot;
}
export function changesBetween(before: Snapshot, after: Snapshot): Change[] {
  const left = new Map(before.entries.map((entry) => [entry.path, entry]));
  const right = new Map(after.entries.map((entry) => [entry.path, entry]));
  return [...new Set([...left.keys(), ...right.keys()])].sort().flatMap((path) => {
    const prior = left.get(path);
    const current = right.get(path);
    if (canonical(prior ?? null) === canonical(current ?? null)) return [];
    return [
      {
        path,
        type: !prior ? ('added' as const) : !current ? ('deleted' as const) : ('modified' as const),
        ...(prior ? { before: prior } : {}),
        ...(current ? { after: current } : {})
      }
    ];
  });
}
export async function snapshotDiff(
  taskRoot: string,
  before: Snapshot,
  after: Snapshot
): Promise<string> {
  const left = `snapshots/${before.snapshotId}/tree`;
  const right = `snapshots/${after.snapshotId}/tree`;
  if (left === right) return '';
  const patch = await git(
    taskRoot,
    [
      'diff',
      '--no-index',
      '--binary',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--',
      left,
      right
    ],
    [0, 1]
  );
  return patch
    .split('\n')
    .map((line) =>
      /^(diff --git |--- |\+\+\+ |Binary files |rename (from|to) |copy (from|to) )/.test(line)
        ? line.replaceAll(left + '/', '').replaceAll(right + '/', '')
        : line
    )
    .join('\n');
}
