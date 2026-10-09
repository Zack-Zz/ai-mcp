import { randomUUID } from 'node:crypto';
import { lstat, realpath, readFile } from 'node:fs/promises';
import { isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';
import type { ProjectConfig, TaskSpec } from '../contracts/validation.js';
import type { Artifact, Delivery, TaskRecord } from '../contracts/types.js';
import { BridgeError } from '../contracts/errors.js';
import { atomicWrite, canonical } from '../runtime/journal.js';
import { git, gitRoot } from './git.js';
import { directory, identity, inside, location, stateDirectory } from './paths.js';
import {
  captureSnapshot,
  changesBetween,
  hashBytes,
  readBaseline,
  snapshotDiff,
  type Change,
  type Snapshot
} from './snapshot.js';
import { runVerification, selectedVerifications } from './verification.js';

export { captureSnapshot, changesBetween, readBaseline, verifySnapshot } from './snapshot.js';
export { runVerification, selectedVerifications } from './verification.js';

export async function inspectWorkspace(
  project: ProjectConfig,
  policy: 'isolated' | 'existing',
  spec?: TaskSpec
): Promise<{
  repoRoot: string;
  workingDirectory: string;
  baselineRef: string;
  dirty: boolean;
  permissionProfile: string;
  scopeEnforcement: 'detect_only';
}> {
  const repoRoot = await directory(project.repoRoot, 'INVALID_REPOSITORY');
  if ((await gitRoot(repoRoot)) !== repoRoot)
    throw new BridgeError(
      'INVALID_REPOSITORY',
      'Registered repoRoot is a nested directory, not its Git root'
    );
  const candidate = resolve(repoRoot, project.workingDirectory);
  if (!inside(repoRoot, candidate))
    throw new BridgeError(
      'WORKSPACE_ESCAPE',
      'Working directory must remain inside its registered repository'
    );
  const workingDirectory = await directory(candidate);
  if (!inside(repoRoot, workingDirectory))
    throw new BridgeError(
      'WORKSPACE_ESCAPE',
      'Working directory symlink escaped its registered repository'
    );
  if (spec) {
    selectedVerifications(project.verifications, spec.verificationIds);
    const contextRoots = await Promise.all(
      project.contextRoots.map((path) => directory(path, 'CONTEXT_ESCAPE'))
    );
    for (const ref of spec.contextRefs) {
      const requested = isAbsolute(ref.path) ? ref.path : resolve(repoRoot, ref.path);
      let actual: string;
      try {
        actual = await realpath(requested);
        if (!(await lstat(actual)).isFile()) throw new Error();
      } catch {
        throw new BridgeError(
          'CONTEXT_MISSING',
          'Context reference must identify an existing regular file'
        );
      }
      if (![repoRoot, ...contextRoots].some((root) => inside(root, actual)))
        throw new BridgeError(
          'CONTEXT_ESCAPE',
          'Context reference escaped registered repository/context roots'
        );
    }
  }
  const dirty = Boolean(
    await git(repoRoot, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  );
  if (dirty && policy === 'isolated')
    throw new BridgeError(
      'DIRTY_SOURCE',
      'Isolated tasks require clean source; existing mode preserves explicitly selected dirty work'
    );
  return {
    repoRoot,
    workingDirectory,
    baselineRef: (await git(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}'])).trim(),
    dirty,
    permissionProfile: project.permissionProfile,
    scopeEnforcement: 'detect_only' as const
  };
}

export async function prepareWorkspace(
  stateRoot: string,
  project: ProjectConfig,
  policy: 'isolated' | 'existing',
  taskId: string,
  spec: TaskSpec
) {
  identity(taskId);
  const inspected = await inspectWorkspace(project, policy, spec);
  if (inside(inspected.repoRoot, await location(resolve(stateRoot))))
    throw new BridgeError('STATE_UNSAFE', 'Bridge state must remain outside the code repository');
  const taskRoot = await stateDirectory(stateRoot, 'tasks', taskId);
  if (
    await lstat(join(taskRoot, 'baseline.json')).catch((error) => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return null;
    })
  )
    throw new BridgeError('WORKSPACE_EXISTS', 'An immutable baseline already exists for this task');
  const workspaceRoot =
    policy === 'existing'
      ? inspected.repoRoot
      : join(await stateDirectory(stateRoot, 'workspaces'), taskId);
  if (policy === 'isolated')
    await git(inspected.repoRoot, [
      'worktree',
      'add',
      '--detach',
      workspaceRoot,
      inspected.baselineRef
    ]);
  const workingDirectory = await directory(
    join(workspaceRoot, relative(inspected.repoRoot, inspected.workingDirectory))
  );
  if (!inside(workspaceRoot, workingDirectory))
    throw new BridgeError('WORKSPACE_ESCAPE', 'Isolated working directory escaped its worktree');
  const baseline = await captureSnapshot(
    taskRoot,
    workspaceRoot,
    workingDirectory,
    inspected.repoRoot,
    project,
    spec
  );
  await atomicWrite(join(taskRoot, 'baseline.json'), canonical(baseline) + '\n');
  return {
    workspaceId: taskId,
    workspaceRoot,
    workingDirectory,
    repoRoot: inspected.repoRoot,
    baselineRef: inspected.baselineRef,
    baselineSnapshotId: baseline.snapshotId
  };
}

async function violations(
  baseline: Snapshot,
  after: Snapshot,
  changes: Change[],
  spec: TaskSpec
): Promise<string[]> {
  const paths = new Set(
    changes
      .filter(
        (change) =>
          baseline.permissionProfile === 'read-only' ||
          !spec.writeScope.some((scope) => matchesGlob(change.path, scope))
      )
      .map((change) => change.path)
  );
  for (const change of changes) {
    if (change.after?.kind === 'blocked') paths.add(change.after.blockedBy ?? change.path);
    if (change.after?.kind === 'symlink') {
      const target = resolve(after.workspaceRoot, change.path, '..', change.after.linkTarget!);
      const actual = await realpath(join(after.workspaceRoot, change.path)).catch((error) => {
        if (!['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        return undefined;
      });
      if (!inside(after.workspaceRoot, target) || (actual && !inside(after.workspaceRoot, actual)))
        paths.add(change.path);
    }
  }
  if (baseline.git.head !== after.git.head || baseline.git.symbolicHead !== after.git.symbolicHead)
    paths.add('.git/HEAD');
  if (baseline.git.refs !== after.git.refs) paths.add('.git/refs');
  if (baseline.git.index !== after.git.index) paths.add('.git/index');
  if (baseline.git.binding !== after.git.binding) paths.add('.git/binding');
  return [...paths].sort();
}

async function artifact(
  directory: string,
  name: string,
  kind: Artifact['kind'],
  content: string
): Promise<Artifact> {
  const path = join(directory, name);
  await atomicWrite(path, content);
  const bytes = await readFile(path);
  return {
    artifactId: randomUUID(),
    kind,
    name,
    path,
    sha256: hashBytes(bytes),
    size: bytes.byteLength
  };
}

export async function captureDelivery(
  stateRoot: string,
  task: TaskRecord,
  runId: string,
  logs: { stdout: string; stderr: string; result: unknown; signal?: AbortSignal }
): Promise<Delivery> {
  const taskRoot = await stateDirectory(stateRoot, 'tasks', identity(task.taskId));
  const baseline = await readBaseline(taskRoot, task.baselineSnapshotId);
  if (
    baseline.projectId !== task.projectId ||
    baseline.workspaceRoot !== task.workspaceRoot ||
    baseline.workingDirectory !== task.workingDirectory ||
    baseline.repoRoot !== task.repoRoot ||
    canonical(baseline.taskSpec) !== canonical(task.spec)
  )
    throw new BridgeError(
      'INVALID_TASK_BINDING',
      'Task workspace/scope no longer matches its immutable baseline'
    );
  const cwd = await directory(task.workingDirectory);
  if (!inside(task.workspaceRoot, cwd))
    throw new BridgeError('WORKSPACE_ESCAPE', 'Verification directory escaped the bound workspace');
  const selected = selectedVerifications(baseline.verifications, task.spec.verificationIds);
  const verifications = [];
  for (const config of selected)
    verifications.push(
      await runVerification(config, cwd, task.spec.limits?.maxLogBytes ?? 1024 * 1024, logs.signal)
    );
  const after = await captureSnapshot(
    taskRoot,
    task.workspaceRoot,
    cwd,
    task.repoRoot,
    {
      id: baseline.projectId,
      permissionProfile: baseline.permissionProfile,
      verifications: baseline.verifications
    },
    task.spec
  );
  const changes = changesBetween(baseline, after);
  const outOfScope = await violations(baseline, after, changes, task.spec);
  const deliveryId = randomUUID();
  const directoryPath = await stateDirectory(taskRoot, 'deliveries', deliveryId);
  const manifest = {
    scopeEnforcement: 'detect_only',
    outOfScope,
    changes,
    before: { snapshotId: baseline.snapshotId, entries: baseline.entries, git: baseline.git },
    after: { snapshotId: after.snapshotId, entries: after.entries, git: after.git }
  };
  const artifacts = [];
  artifacts.push(
    await artifact(
      directoryPath,
      'diff.patch',
      'diff',
      await snapshotDiff(taskRoot, baseline, after)
    )
  );
  artifacts.push(
    await artifact(directoryPath, 'manifest.json', 'manifest', canonical(manifest) + '\n')
  );
  artifacts.push(
    await artifact(
      directoryPath,
      'verification.json',
      'verification',
      canonical(verifications) + '\n'
    )
  );
  artifacts.push(
    await artifact(directoryPath, 'result.json', 'result', canonical(logs.result ?? null) + '\n')
  );
  artifacts.push(await artifact(directoryPath, 'stdout.jsonl', 'stdout', logs.stdout));
  artifacts.push(await artifact(directoryPath, 'stderr.log', 'stderr', logs.stderr));
  return {
    deliveryId,
    runId,
    snapshotId: after.snapshotId,
    baselineSnapshotId: baseline.snapshotId,
    createdAt: new Date().toISOString(),
    scopeEnforcement: 'detect_only',
    outOfScope,
    artifacts,
    verifications
  };
}
