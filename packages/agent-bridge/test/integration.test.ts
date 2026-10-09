import { describe, expect, it } from 'vitest';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import type { TaskRecord, OperationReply } from '../src/contracts/types.js';
const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx/esm');
async function call(
  configPath: string,
  args: string[]
): Promise<OperationReply & { code: number | null }> {
  const child = spawn(
    process.execPath,
    ['--import', loader, cli, ...args, '--config', configPath, '--json'],
    { stdio: ['ignore', 'pipe', 'pipe'], shell: false }
  );
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  const lines = stdout.trim().split('\n');
  expect(lines, stderr).toHaveLength(1);
  return { ...JSON.parse(lines[0]!), code } as OperationReply & { code: number | null };
}
async function stopped(configPath: string, taskId: string): Promise<TaskRecord> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await call(configPath, ['task', 'get', taskId]);
    expect(result.code).toBe(0);
    const task = result.data as TaskRecord;
    if (['completed', 'failed', 'cancelled'].includes(task.state)) return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Task did not stop within its test bound');
}

describe('Real CLI, IPC, application, process and delivery integration with a fixture engine', () => {
  it('retains a durable workspace quarantine when an escaped native pipe holder outlives its owned group', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-escaped-integration-'));
    const repo = join(root, 'project');
    const stateRoot = join(root, 'state');
    const configPath = join(root, 'bridge.json');
    const specPath = join(root, 'spec.json');
    const childPidPath = join(root, 'escaped.pid');
    const verificationMarker = join(root, 'verification-ran');
    let escapedPid: number | undefined;
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'value.txt'), 'ZERO');
    await execute('git', ['init', '-q', repo]);
    await execute('git', ['-C', repo, 'add', '.']);
    await execute('git', [
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Temporary escaped baseline'
    ]);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        stateRoot,
        defaultCallerRef: 'origin',
        timeoutMs: 5000,
        projects: [
          {
            id: 'sample',
            repoRoot: repo,
            verifications: [
              {
                id: 'marker',
                command: process.execPath,
                args: [
                  '-e',
                  `require('fs').writeFileSync(${JSON.stringify(verificationMarker)}, 'ran')`
                ]
              }
            ]
          }
        ],
        engines: {
          codex: {
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/app-server-engine.mjs', import.meta.url))],
            env: {
              FIXTURE_MODE: 'pipe-tail',
              FIXTURE_CHILD_PID: childPidPath,
              FIXTURE_TAIL_MS: '15000'
            }
          }
        },
        clients: [{ id: 'origin', role: 'controller', engine: 'codex', allowUnverified: true }]
      }),
      { mode: 0o600 }
    );
    await writeFile(
      specPath,
      JSON.stringify({
        taskSpecVersion: '1',
        objective: 'Inspect value',
        acceptanceCriteria: ['Registered checks run only after stop is proven'],
        writeScope: ['src/value.txt'],
        scopeReference: 'human:escaped-process-regression',
        verificationIds: ['marker']
      })
    );
    const start = (id: string) => [
      'task',
      'start',
      '--engine',
      'codex',
      '--project',
      'sample',
      '--request-id',
      id,
      '--workspace-policy',
      'existing',
      '--independent-session',
      '--spec-file',
      specPath
    ];
    try {
      const ack = await call(configPath, start('escaped-first'));
      expect(ack.code, JSON.stringify(ack)).toBe(0);
      const taskId = (ack.data as TaskRecord).taskId;
      let task = ack.data as TaskRecord;
      for (let i = 0; i < 100; i++) {
        task = (await call(configPath, ['task', 'get', taskId])).data as TaskRecord;
        if (['recovery_required', 'failed', 'completed'].includes(task.state)) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      escapedPid = Number(await readFile(childPidPath, 'utf8'));
      expect(() => process.kill(escapedPid!, 0)).not.toThrow();
      expect(task.state).toBe('recovery_required');
      expect(task.runs[0]?.outcome).toMatchObject({
        processGroupExited: true,
        executionStopped: false,
        executionDisposition: 'unknown'
      });
      expect(task.deliveries).toHaveLength(0);
      await expect(readFile(verificationMarker)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await call(configPath, start('next-writer'))).error?.code).toBe('WORKSPACE_BUSY');
      expect(
        (await call(configPath, ['task', 'cancel', taskId, '--request-id', 'claim-cancelled']))
          .error?.code
      ).toBe('EXECUTION_UNKNOWN');
      await call(configPath, ['runtime', 'stop', '--request-id', 'quarantine-restart']);
      expect((await call(configPath, ['task', 'get', taskId])).data).toMatchObject({
        state: 'recovery_required'
      });
      expect((await call(configPath, start('writer-after-restart'))).error?.code).toBe(
        'WORKSPACE_BUSY'
      );
      expect(
        (
          await call(configPath, [
            'task',
            'continue',
            taskId,
            '--request-id',
            'resume-unsafe',
            '--message-file',
            specPath
          ])
        ).error?.code
      ).toBe('EXECUTION_UNKNOWN');
      expect(() => process.kill(escapedPid!, 0)).not.toThrow();
    } finally {
      await call(configPath, ['runtime', 'stop', '--request-id', 'escaped-final-stop']);
      if (!escapedPid) {
        try {
          escapedPid = Number(await readFile(childPidPath, 'utf8'));
        } catch {
          /* Fixture never spawned it. */
        }
      }
      if (escapedPid) {
        try {
          process.kill(-escapedPid, 'SIGKILL');
        } catch {
          /* Our registered fixture child already exited. */
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it('uses the default Codex RPC transport across runtime restart, exact continuation and owned cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-rpc-integration-'));
    const repo = join(root, 'project');
    const stateRoot = join(root, 'state');
    const configPath = join(root, 'bridge.json');
    const specPath = join(root, 'spec.json');
    const feedbackPath = join(root, 'feedback.txt');
    const rpcLog = join(stateRoot, 'rpc.jsonl');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'value.txt'), 'ZERO');
    await execute('git', ['init', '-q', repo]);
    await execute('git', ['-C', repo, 'add', '.']);
    await execute('git', [
      '-C',
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '-qm',
      'Temporary RPC baseline'
    ]);
    const config = {
      schemaVersion: 1,
      stateRoot,
      defaultCallerRef: 'origin',
      timeoutMs: 10000,
      projects: [
        {
          id: 'sample',
          repoRoot: repo,
          verifications: [
            {
              id: 'unchanged',
              command: process.execPath,
              args: [
                '-e',
                "if(require('fs').readFileSync('src/value.txt','utf8')!=='ZERO')process.exit(2)"
              ]
            }
          ]
        }
      ],
      engines: {
        codex: {
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/app-server-engine.mjs', import.meta.url))],
          env: { FIXTURE_LOG: rpcLog, FIXTURE_MODE: 'normal' }
        }
      },
      clients: [{ id: 'origin', role: 'controller', engine: 'codex', allowUnverified: true }]
    };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    await writeFile(
      specPath,
      JSON.stringify({
        taskSpecVersion: '1',
        objective: 'Inspect the registered value',
        acceptanceCriteria: ['Independent unchanged verification passes'],
        writeScope: ['src/value.txt'],
        constraints: ['Inspect only; registered verification must prove the value is unchanged'],
        scopeReference: 'human:rpc-integration',
        verificationIds: ['unchanged']
      })
    );
    const start = [
      'task',
      'start',
      '--engine',
      'codex',
      '--project',
      'sample',
      '--request-id',
      'rpc-create',
      '--independent-session',
      '--spec-file',
      specPath
    ];
    const requests = async () =>
      (await readFile(rpcLog, 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
    try {
      const ack = await call(configPath, start);
      expect(ack.code, JSON.stringify(ack)).toBe(0);
      const first = await stopped(configPath, (ack.data as TaskRecord).taskId);
      expect(first.state).toBe('completed');
      expect(first.runs).toHaveLength(1);
      expect(first.deliveries[0]?.verifications[0]?.exitCode).toBe(0);
      expect((await call(configPath, start)).data).toMatchObject({ taskId: first.taskId });
      expect((await requests()).filter((r) => r.method === 'thread/start')).toHaveLength(1);
      expect(
        (await call(configPath, ['runtime', 'stop', '--request-id', 'rpc-between-runs'])).code
      ).toBe(0);
      expect((await call(configPath, ['task', 'get', first.taskId])).data).toMatchObject({
        sessionId: first.sessionId
      });
      await writeFile(feedbackPath, 'Read the exact original session again');
      expect(
        (
          await call(configPath, [
            'task',
            'continue',
            first.taskId,
            '--request-id',
            'rpc-continue',
            '--message-file',
            feedbackPath
          ])
        ).code
      ).toBe(0);
      const second = await stopped(configPath, first.taskId);
      expect(second.state).toBe('completed');
      expect(second.runs).toHaveLength(2);
      expect(second.sessionId).toBe(first.sessionId);
      expect((await requests()).find((r) => r.method === 'thread/resume')?.params).toMatchObject({
        threadId: first.sessionId
      });
      expect(
        (await call(configPath, ['runtime', 'stop', '--request-id', 'rpc-before-cancel'])).code
      ).toBe(0);
      config.engines.codex.env.FIXTURE_MODE = 'hang-turn';
      await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
      expect(
        (
          await call(configPath, [
            'task',
            'continue',
            first.taskId,
            '--request-id',
            'rpc-hold',
            '--message-file',
            feedbackPath
          ])
        ).code
      ).toBe(0);
      for (let i = 0; i < 100; i++) {
        if ((await requests()).filter((r) => r.method === 'turn/start').length === 3) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect((await requests()).filter((r) => r.method === 'turn/start')).toHaveLength(3);
      expect(
        (await call(configPath, ['task', 'cancel', first.taskId, '--request-id', 'rpc-cancel']))
          .code
      ).toBe(0);
      const cancelled = await stopped(configPath, first.taskId);
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.runs).toHaveLength(3);
      expect(cancelled.runs[2]?.outcome?.processGroupExited).toBe(true);
      expect(cancelled.sessionId).toBe(first.sessionId);
      expect(await readFile(join(repo, 'src', 'value.txt'), 'utf8')).toBe('ZERO');
    } finally {
      await call(configPath, ['runtime', 'stop', '--request-id', 'rpc-final-stop']);
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
  it('persists one independent task through CLI disconnect, exact resume, artifacts, scope failure and owned cancellation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-integration-'));
    const repo = join(root, 'project with spaces');
    const stateRoot = join(root, 'private state');
    const configPath = join(root, 'controlled config.json');
    const specPath = join(root, 'task spec.json');
    const messagePath = join(root, 'feedback.txt');
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'value.txt'), 'ZERO');
    await execute('git', ['init', '-q', repo]);
    await execute('git', ['-C', repo, 'config', 'user.name', 'Bridge Fixture']);
    await execute('git', ['-C', repo, 'config', 'user.email', 'bridge-fixture@example.invalid']);
    await execute('git', ['-C', repo, 'add', '.']);
    await execute('git', ['-C', repo, 'commit', '-qm', 'Fixture baseline']);
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        stateRoot,
        defaultCallerRef: 'origin',
        timeoutMs: 10000,
        projects: [
          {
            id: 'sample',
            repoRoot: repo,
            verifications: [
              {
                id: 'content',
                command: process.execPath,
                args: [
                  '-e',
                  "const fs=require('node:fs');process.exit(['ONE','TWO'].includes(fs.readFileSync('src/value.txt','utf8'))?0:2)"
                ]
              }
            ]
          }
        ],
        engines: {
          codex: {
            codexTransport: 'exec',
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/integration-engine.mjs', import.meta.url))],
            env: {
              FIXTURE_EXEC_LOG: join(stateRoot, 'native-calls.jsonl'),
              FIXTURE_SESSION_ROOT: stateRoot
            }
          }
        },
        clients: [
          { id: 'origin', role: 'controller', engine: 'codex', allowUnverified: true },
          { id: 'outsider', role: 'controller', engine: 'zcode' }
        ]
      }),
      { mode: 0o600 }
    );
    await writeFile(
      specPath,
      JSON.stringify({
        taskSpecVersion: '1',
        objective: 'Set value ONE',
        acceptanceCriteria: ['Scoped value file is updated'],
        writeScope: ['src/value.txt'],
        scopeReference: 'human:integration-validation',
        verificationIds: ['content']
      })
    );
    try {
      const denied = await call(configPath, [
        'task',
        'start',
        '--engine',
        'codex',
        '--project',
        'sample',
        '--spec-file',
        specPath,
        '--request-id',
        'no-explicit-session'
      ]);
      expect(denied.code).toBe(2);
      expect(denied.error?.code).toBe('POLICY_DENIED');
      const argv = [
        'task',
        'start',
        '--engine',
        'codex',
        '--project',
        'sample',
        '--spec-file',
        specPath,
        '--independent-session',
        '--request-id',
        'start-one'
      ];
      const start = await call(configPath, argv);
      expect(start.code, JSON.stringify(start)).toBe(0);
      const first = start.data as TaskRecord;
      expect(first.state).toBe('queued');
      expect(first.workspacePolicy).toBe('isolated');
      expect(first.workspaceRoot).not.toBe(repo);
      const duplicate = await call(configPath, argv);
      expect((duplicate.data as TaskRecord).taskId).toBe(first.taskId);
      const completed = await stopped(configPath, first.taskId);
      expect(completed.state, JSON.stringify(completed.attention)).toBe('completed');
      expect(completed.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(completed.deliveries).toHaveLength(1);
      expect(completed.deliveries[0]!.verifications[0]!.exitCode).toBe(0);
      expect(await readFile(join(repo, 'src', 'value.txt'), 'utf8')).toBe('ZERO');
      expect(await readFile(join(completed.workspaceRoot, 'src', 'value.txt'), 'utf8')).toBe('ONE');
      expect(
        (await readFile(join(stateRoot, 'native-calls.jsonl'), 'utf8')).trim().split('\n')
      ).toHaveLength(1);
      const outside = await call(configPath, [
        'task',
        'get',
        first.taskId,
        '--caller-ref',
        'outsider'
      ]);
      expect(outside.error?.code).toBe('POLICY_DENIED');
      const listing = await call(configPath, ['artifact', 'list', '--task', first.taskId]);
      const artifacts = (
        listing.data as { artifacts: Array<{ artifactId: string; kind: string; path?: string }> }
      ).artifacts;
      expect(artifacts).toHaveLength(6);
      expect(artifacts.every((artifact) => artifact.path === undefined)).toBe(true);
      const diff = artifacts.find((artifact) => artifact.kind === 'diff')!;
      const page = await call(configPath, [
        'artifact',
        'read',
        diff.artifactId,
        '--task',
        first.taskId,
        '--limit',
        '20'
      ]);
      expect((page.data as { bytesRead: number; truncated: boolean }).bytesRead).toBe(20);
      expect((page.data as { truncated: boolean }).truncated).toBe(true);
      await writeFile(messagePath, 'Set value TWO');
      const continued = await call(configPath, [
        'task',
        'continue',
        first.taskId,
        '--message-file',
        messagePath,
        '--request-id',
        'continue-one'
      ]);
      expect(continued.code).toBe(0);
      const resumed = await stopped(configPath, first.taskId);
      expect(resumed.state).toBe('completed');
      expect(resumed.sessionId).toBe(completed.sessionId);
      expect(resumed.runs).toHaveLength(2);
      expect(resumed.deliveries).toHaveLength(2);
      const calls = (await readFile(join(stateRoot, 'native-calls.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { resume?: string });
      expect(calls[1]!.resume).toBe(completed.sessionId);
      await writeFile(messagePath, 'Write outside scope');
      await call(configPath, [
        'task',
        'continue',
        first.taskId,
        '--message-file',
        messagePath,
        '--request-id',
        'scope-failure'
      ]);
      const failed = await stopped(configPath, first.taskId);
      expect(failed.state).toBe('failed');
      expect(failed.attention?.code).toBe('SCOPE_VIOLATION');
      expect(failed.deliveries.at(-1)!.outOfScope).toContain('src/forbidden.txt');
      await writeFile(messagePath, 'Hold for cancellation');
      await call(configPath, [
        'task',
        'continue',
        first.taskId,
        '--message-file',
        messagePath,
        '--request-id',
        'long-run'
      ]);
      const cancel = await call(configPath, [
        'task',
        'cancel',
        first.taskId,
        '--request-id',
        'cancel-owned'
      ]);
      expect(cancel.code).toBe(0);
      const cancelled = await stopped(configPath, first.taskId);
      expect(cancelled.state).toBe('cancelled');
      expect(cancelled.runs.at(-1)!.outcome!.executionDisposition).toBe('unknown');
      const events = await call(configPath, ['task', 'watch', first.taskId, '--wait-ms', '0']);
      expect((events.data as { events: unknown[] }).events.length).toBeGreaterThan(0);
      const stop = await call(configPath, ['runtime', 'stop', '--request-id', 'shutdown']);
      expect(stop.code).toBe(0);
      for (let attempt = 0; attempt < 100; attempt++) {
        const exists = await lstat(join(stateRoot, 'runtime.lock.json')).then(
          () => true,
          () => false
        );
        if (!exists) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const persisted = await call(configPath, ['task', 'get', first.taskId]);
      expect((persisted.data as TaskRecord).sessionId).toBe(completed.sessionId);
      expect((persisted.data as TaskRecord).state).toBe('cancelled');
    } finally {
      await call(configPath, ['runtime', 'stop', '--request-id', 'cleanup']).catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }, 40000);
});
