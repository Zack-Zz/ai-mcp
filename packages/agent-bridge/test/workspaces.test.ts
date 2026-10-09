import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  chmod,
  unlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ProjectConfig, TaskSpec } from '../src/contracts/validation.js';
import type { TaskRecord } from '../src/contracts/types.js';
import { inspectWorkspace, prepareWorkspace, captureDelivery } from '../src/workspaces/index.js';

const run = promisify(execFile);
const verifierFixture = fileURLToPath(
  new URL('./fixtures/workspace-verification.mjs', import.meta.url)
);
const spec: TaskSpec = {
  taskSpecVersion: '1',
  objective: 'A bounded test',
  acceptanceCriteria: ['verify change'],
  constraints: [],
  writeScope: ['src/**'],
  contextRefs: [{ path: 'src/file.txt' }],
  scopeReference: 'fixture user request',
  verificationIds: []
};
let root: string;
let repo: string;
let state: string;
let project: ProjectConfig;
async function git(...args: string[]) {
  return (await run('git', args, { cwd: repo })).stdout.trim();
}
function task(
  workspace: Awaited<ReturnType<typeof prepareWorkspace>>,
  taskSpec = spec
): TaskRecord {
  return {
    taskId: 'task1',
    engine: 'codex',
    projectId: project.id,
    owner: { id: 'caller', role: 'controller', allowUnverified: false },
    state: 'running',
    requestId: 'request1',
    spec: taskSpec,
    sessionPolicy: 'new',
    workspacePolicy: 'existing',
    permissionProfile: project.permissionProfile,
    projectConfigHash: '0'.repeat(64),
    ...workspace,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    runs: [],
    deliveries: []
  };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'bridge-workspace-test-')));
  repo = join(root, 'repo');
  state = join(root, 'state');
  await mkdir(join(repo, 'src'), { recursive: true });
  await writeFile(join(repo, 'src/file.txt'), 'original\n');
  await writeFile(join(repo, '.gitignore'), 'ignored.txt\n');
  await git('init', '--initial-branch=main');
  await git('add', '.');
  await git(
    '-c',
    'user.name=Bridge fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-m',
    'fixture baseline'
  );
  project = {
    id: 'fixture',
    repoRoot: repo,
    workingDirectory: '.',
    contextRoots: [],
    permissionProfile: 'workspace-write',
    verifications: []
  };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('workspace read-only preflight and immutable baseline', () => {
  it('resolves the actual Git root and exact HEAD without creating state', async () => {
    const result = await inspectWorkspace(project, 'isolated', spec);
    expect(result.baselineRef).toBe(await git('rev-parse', 'HEAD'));
    expect(result.repoRoot).toBe(repo);
    expect(result.scopeEnforcement).toBe('detect_only');
    await expect(readFile(join(state, 'tasks/task1/baseline.json'))).rejects.toHaveProperty(
      'code',
      'ENOENT'
    );
  });
  it('does not treat dirty source as clean for isolated tasks', async () => {
    await writeFile(join(repo, 'src/file.txt'), 'existing dirty\n');
    await expect(inspectWorkspace(project, 'isolated', spec)).rejects.toMatchObject({
      code: 'DIRTY_SOURCE'
    });
    await expect(prepareWorkspace(state, project, 'isolated', 'task1', spec)).rejects.toMatchObject(
      { code: 'DIRTY_SOURCE' }
    );
    expect(await readFile(join(repo, 'src/file.txt'), 'utf8')).toBe('existing dirty\n');
  });
  it('creates a detached isolated worktree at the inspected HEAD', async () => {
    const workspace = await prepareWorkspace(state, project, 'isolated', 'task1', spec);
    expect(workspace.workspaceRoot).toBe(join(state, 'workspaces/task1'));
    expect(workspace.baselineRef).toBe(await git('rev-parse', 'HEAD'));
    expect(
      (
        await run('git', ['symbolic-ref', '-q', 'HEAD'], { cwd: workspace.workspaceRoot }).catch(
          (error) => error
        )
      ).code
    ).toBe(1);
    expect(await readFile(join(workspace.workingDirectory, 'src/file.txt'), 'utf8')).toBe(
      'original\n'
    );
    expect(workspace.baselineSnapshotId).toMatch(/^[a-f0-9]{64}$/);
  });
  it('uses an existing dirty baseline so unchanged dirty files are not task changes', async () => {
    await writeFile(join(repo, 'src/file.txt'), 'before task dirty\n');
    await writeFile(join(repo, 'untracked.txt'), 'preexisting\n');
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    const delivery = await captureDelivery(state, task(workspace), 'run1', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(delivery.outOfScope).toEqual([]);
    expect(delivery.artifacts).toHaveLength(6);
    const diff = delivery.artifacts.find((item) => item.kind === 'diff')!;
    expect(await readFile(diff.path, 'utf8')).toBe('');
    expect(await readFile(join(repo, 'src/file.txt'), 'utf8')).toBe('before task dirty\n');
  });
});

describe('workspace authorization and delivery evidence', () => {
  it('rejects a registered directory that is not the actual Git root and workdir escapes', async () => {
    await expect(
      inspectWorkspace({ ...project, repoRoot: join(repo, 'src') }, 'existing', spec)
    ).rejects.toMatchObject({ code: 'INVALID_REPOSITORY' });
    await expect(
      inspectWorkspace({ ...project, workingDirectory: '..' }, 'existing', spec)
    ).rejects.toMatchObject({ code: 'WORKSPACE_ESCAPE' });
    await symlink(root, join(repo, 'escape'));
    await expect(
      inspectWorkspace({ ...project, workingDirectory: 'escape' }, 'existing', spec)
    ).rejects.toMatchObject({ code: 'WORKSPACE_ESCAPE' });
  });
  it('allows only actual file contexts inside repository or registered context roots', async () => {
    const contexts = join(root, 'contexts');
    await mkdir(contexts);
    await writeFile(join(contexts, 'guide.md'), 'guide');
    await expect(
      inspectWorkspace(project, 'existing', {
        ...spec,
        contextRefs: [{ path: join(contexts, 'guide.md') }]
      })
    ).rejects.toMatchObject({ code: 'CONTEXT_ESCAPE' });
    await expect(
      inspectWorkspace({ ...project, contextRoots: [contexts] }, 'existing', {
        ...spec,
        contextRefs: [{ path: join(contexts, 'guide.md') }]
      })
    ).resolves.toBeTruthy();
    await symlink(join(contexts, 'guide.md'), join(repo, 'linked-context'));
    await expect(
      inspectWorkspace(project, 'existing', { ...spec, contextRefs: [{ path: 'linked-context' }] })
    ).rejects.toMatchObject({ code: 'CONTEXT_ESCAPE' });
    await expect(
      inspectWorkspace(project, 'existing', { ...spec, contextRefs: [{ path: 'src/missing.txt' }] })
    ).rejects.toMatchObject({ code: 'CONTEXT_MISSING' });
  });
  it('records new/delete/mode/link target changes and hashes every artifact', async () => {
    await symlink('file.txt', join(repo, 'src/link'));
    await git('add', 'src/link');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '-m',
      'fixture link'
    );
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await unlink(join(repo, 'src/file.txt'));
    await writeFile(join(repo, 'src/new.txt'), 'new content\n');
    await chmod(join(repo, 'src/new.txt'), 0o755);
    await unlink(join(repo, 'src/link'));
    await symlink('new.txt', join(repo, 'src/link'));
    await writeFile(join(repo, 'out.txt'), 'outside scope\n');
    await writeFile(join(repo, 'ignored.txt'), 'ignored\n');
    const delivery = await captureDelivery(state, task(workspace), 'run1', {
      stdout: '{"event":"done"}\n',
      stderr: 'warn',
      result: { status: 'completed' }
    });
    expect(delivery.outOfScope).toEqual(['out.txt']);
    const manifest = JSON.parse(
      await readFile(delivery.artifacts.find((item) => item.kind === 'manifest')!.path, 'utf8')
    );
    expect(manifest.changes.map((change: { path: string }) => change.path)).toEqual([
      'out.txt',
      'src/file.txt',
      'src/link',
      'src/new.txt'
    ]);
    expect(
      manifest.changes.find((change: { path: string }) => change.path === 'src/link').after
        .linkTarget
    ).toBe('new.txt');
    expect(manifest.after.entries.map((entry: { path: string }) => entry.path)).not.toContain(
      'ignored.txt'
    );
    for (const artifact of delivery.artifacts) {
      const bytes = await readFile(artifact.path);
      expect(artifact.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(artifact.size).toBe(bytes.byteLength);
      expect(
        artifact.path.startsWith(join(state, 'tasks/task1/deliveries', delivery.deliveryId))
      ).toBe(true);
    }
    expect(
      await readFile(delivery.artifacts.find((item) => item.kind === 'diff')!.path, 'utf8')
    ).toContain('new content');
  });
  it('detects actual mode-only changes and every readonly file change', async () => {
    project = { ...project, permissionProfile: 'read-only' };
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await chmod(join(repo, 'src/file.txt'), 0o755);
    const delivery = await captureDelivery(state, task(workspace), 'run1', {
      stdout: '',
      stderr: '',
      result: null
    });
    expect(delivery.outOfScope).toEqual(['src/file.txt']);
  });
  it('detects Git HEAD/ref/index mutation without undoing the model commit', async () => {
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await writeFile(join(repo, 'src/file.txt'), 'committed by fixture model\n');
    await git('add', 'src/file.txt');
    await git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=f@example.invalid',
      'commit',
      '-m',
      'fixture model commit'
    );
    const head = await git('rev-parse', 'HEAD');
    const delivery = await captureDelivery(state, task(workspace), 'run1', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(delivery.outOfScope).toContain('.git/HEAD');
    expect(delivery.outOfScope).toContain('.git/refs');
    expect(await git('rev-parse', 'HEAD')).toBe(head);
  });
  it('executes only registered verification IDs with real exit/output evidence', async () => {
    project = {
      ...project,
      verifications: [
        {
          id: 'checks',
          command: process.execPath,
          args: [
            '-e',
            'process.stdout.write(process.cwd());process.stderr.write("verification failed");process.exit(7)'
          ],
          timeoutMs: 1000
        }
      ]
    };
    const taskSpec = { ...spec, verificationIds: ['checks'] };
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', taskSpec);
    const delivery = await captureDelivery(state, task(workspace, taskSpec), 'run1', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(delivery.verifications[0]).toMatchObject({
      id: 'checks',
      exitCode: 7,
      stdout: repo,
      stderr: 'verification failed'
    });
    expect(delivery.verifications[0]!.durationMs).toBeGreaterThanOrEqual(0);
  });
  it('rejects model-invented verification IDs before preparing workspace', async () => {
    await expect(
      prepareWorkspace(state, project, 'existing', 'task1', {
        ...spec,
        verificationIds: ['arbitrary-command']
      })
    ).rejects.toMatchObject({ code: 'UNKNOWN_VERIFICATION' });
  });
  it('does not follow a model symlinked directory to read outside contents', async () => {
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'file.txt'), 'outside secret sentinel');
    await rm(join(repo, 'src'), { recursive: true });
    await symlink(outside, join(repo, 'src'));
    const delivery = await captureDelivery(state, task(workspace), 'run1', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(delivery.outOfScope).toContain('src');
    const manifest = await readFile(
      delivery.artifacts.find((item) => item.kind === 'manifest')!.path,
      'utf8'
    );
    expect(manifest).not.toContain('outside secret sentinel');
  });
  it('records index semantic flags but ignores a normal stat-cache refresh', async () => {
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await git('update-index', '--refresh');
    const clean = await captureDelivery(state, task(workspace), 'clean', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(clean.outOfScope).toEqual([]);
    await git('update-index', '--assume-unchanged', 'src/file.txt');
    const changed = await captureDelivery(state, task(workspace), 'flag', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(changed.outOfScope).toContain('.git/index');
  });
  it('rejects unmanifested files injected into the immutable baseline tree', async () => {
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await writeFile(
      join(state, 'tasks/task1/snapshots', workspace.baselineSnapshotId, 'tree', 'injected.txt'),
      'not a baseline file'
    );
    await expect(
      captureDelivery(state, task(workspace), 'run1', { stdout: '', stderr: '', result: {} })
    ).rejects.toMatchObject({ code: 'BASELINE_CORRUPT' });
  });
  it('hash-binds stored snapshot manifest and refuses changing the bound task spec', async () => {
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await expect(
      captureDelivery(state, task(workspace, { ...spec, writeScope: ['**'] }), 'run1', {
        stdout: '',
        stderr: '',
        result: {}
      })
    ).rejects.toMatchObject({ code: 'INVALID_TASK_BINDING' });
    await writeFile(
      join(state, 'tasks/task1/snapshots', workspace.baselineSnapshotId, 'snapshot.json'),
      '{}'
    );
    await expect(
      captureDelivery(state, task(workspace), 'run1', { stdout: '', stderr: '', result: {} })
    ).rejects.toMatchObject({ code: 'BASELINE_CORRUPT' });
  });
  it('detects a changed target that is restored to original dirty baseline over multiple runs', async () => {
    await writeFile(join(repo, 'src/file.txt'), 'dirty baseline');
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await writeFile(join(repo, 'src/file.txt'), 'intermediate');
    const first = await captureDelivery(state, task(workspace), 'first', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(
      await readFile(first.artifacts.find((item) => item.kind === 'diff')!.path, 'utf8')
    ).toContain('intermediate');
    await writeFile(join(repo, 'src/file.txt'), 'dirty baseline');
    const restored = await captureDelivery(state, task(workspace), 'restored', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(
      await readFile(restored.artifacts.find((item) => item.kind === 'diff')!.path, 'utf8')
    ).toBe('');
    expect(restored.snapshotId).toBe(workspace.baselineSnapshotId);
  });
  it('bounds verification output and records real timeout termination', async () => {
    project = {
      ...project,
      verifications: [
        {
          id: 'output',
          command: process.execPath,
          args: [verifierFixture, 'output'],
          timeoutMs: 1000
        },
        { id: 'hang', command: process.execPath, args: [verifierFixture, 'hang'], timeoutMs: 100 }
      ]
    };
    const taskSpec = {
      ...spec,
      verificationIds: ['output', 'hang'],
      limits: { maxLogBytes: 1024 }
    };
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', taskSpec);
    const delivery = await captureDelivery(state, task(workspace, taskSpec), 'run1', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(delivery.verifications[0]!.stdout.length).toBeLessThanOrEqual(1024);
    expect(delivery.verifications[0]!.stderr).toContain('OUTPUT_TRUNCATED');
    expect(delivery.verifications[1]!.stderr).toContain('VERIFICATION_TIMEOUT');
    expect(delivery.verifications[1]!.exitCode).toBeNull();
    expect(delivery.verifications[1]!.durationMs).toBeLessThan(1500);
  });
  it('cancels verification independently of an already completed engine result', async () => {
    project = {
      ...project,
      verifications: [
        { id: 'hang', command: process.execPath, args: [verifierFixture, 'hang'], timeoutMs: 10000 }
      ]
    };
    const taskSpec = { ...spec, verificationIds: ['hang'] };
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', taskSpec);
    const controller = new AbortController();
    const promise = captureDelivery(state, task(workspace, taskSpec), 'run1', {
      stdout: '',
      stderr: '',
      result: { status: 'completed' },
      signal: controller.signal
    });
    setTimeout(() => controller.abort(), 100);
    const delivery = await promise;
    expect(delivery.verifications[0]!.durationMs).toBeLessThan(1500);
    expect(delivery.verifications[0]!.stderr).toContain('VERIFICATION_CANCELLED');
    expect(
      JSON.parse(
        await readFile(delivery.artifacts.find((item) => item.kind === 'result')!.path, 'utf8')
      )
    ).toEqual({ status: 'completed' });
  });
  it('marks newly introduced links that escape through an existing symlink chain', async () => {
    const outside = join(root, 'outside.txt');
    await writeFile(outside, 'outside sentinel');
    await symlink(outside, join(repo, 'src/alias'));
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await symlink('alias', join(repo, 'src/newlink'));
    const delivery = await captureDelivery(state, task(workspace), 'run1', {
      stdout: '',
      stderr: '',
      result: {}
    });
    expect(delivery.outOfScope).toContain('src/newlink');
  });
  it('rejects a task whose project identity changed despite matching workspace paths', async () => {
    const workspace = await prepareWorkspace(state, project, 'existing', 'task1', spec);
    await expect(
      captureDelivery(state, { ...task(workspace), projectId: 'other-project' }, 'run1', {
        stdout: '',
        stderr: '',
        result: {}
      })
    ).rejects.toMatchObject({ code: 'INVALID_TASK_BINDING' });
  });
  it('rejects symlinked state children and storing task state inside code repository', async () => {
    await expect(
      prepareWorkspace(join(repo, '.bridge-state'), project, 'existing', 'task1', spec)
    ).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
    await mkdir(state);
    const outside = join(root, 'outside-state');
    await mkdir(outside);
    await symlink(outside, join(state, 'workspaces'));
    await expect(prepareWorkspace(state, project, 'isolated', 'task1', spec)).rejects.toMatchObject(
      { code: 'STATE_UNSAFE' }
    );
  });
});
