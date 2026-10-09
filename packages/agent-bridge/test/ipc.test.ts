import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, lstat, readFile, writeFile, symlink, chmod, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serveRuntime, type AppPort } from '../src/runtime/ipc.js';
import { BridgeClient } from '../src/client/index.js';
import { parseConfig } from '../src/contracts/validation.js';
import { createConnection } from 'node:net';
import {
  endpoint,
  processIdentity,
  writeExclusive,
  readPrivate,
  readBinding
} from '../src/client/security.js';
import { spawn } from 'node:child_process';
import { BridgeError } from '../src/contracts/errors.js';
import { signRequest } from '../src/client/authentication.js';
import { digest } from '../src/runtime/journal.js';
function raw(path: string, value: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let text = '';
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(value) + '\n'));
    socket.on('data', (chunk) => {
      text += chunk.toString();
      if (text.includes('\n')) {
        socket.destroy();
        resolve(JSON.parse(text.trim()) as Record<string, unknown>);
      }
    });
  });
}

function config(root: string) {
  return parseConfig({
    schemaVersion: 1,
    stateRoot: root,
    projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
    engines: { codex: { command: 'codex' } },
    clients: [
      { id: 'terminal', role: 'controller' },
      { id: 'worker', role: 'worker' }
    ]
  });
}
function application(): AppPort {
  return {
    async dispatch(caller, operation, args) {
      return { caller, operation, args };
    },
    async close() {},
    async idle() {}
  };
}
describe('Private authenticated local control IPC', () => {
  it('recovers a dead recovery owner atomically without admitting two writers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-recovery-'));
    const cfg = config(root);
    const target = await endpoint(cfg);
    const old = {
      schemaVersion: 1,
      pid: 2147483647,
      processStartIdentity: 'old-absent-process',
      configHash: target.configHash,
      stateRoot: target.stateRoot,
      nonce: 'old-runtime'
    };
    await writeExclusive(target.lockPath, JSON.stringify(old));
    const recovery = target.lockPath + '.recovery';
    await mkdir(recovery, { mode: 0o700 });
    const nonce = 'a'.repeat(48);
    await writeExclusive(
      join(recovery, `owner-${nonce}.json`),
      JSON.stringify({ ...old, pid: 2147483646, nonce })
    );
    let server: Awaited<ReturnType<typeof serveRuntime>> | undefined;
    try {
      const results = await Promise.allSettled([
        serveRuntime(cfg, { application: application() }),
        serveRuntime(cfg, { application: application() })
      ]);
      const successful = results.filter((result) => result.status === 'fulfilled');
      expect(successful).toHaveLength(1);
      server = (successful[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof serveRuntime>>>)
        .value;
      expect(await (await BridgeClient.connect(cfg)).dispatch('engine.list')).toMatchObject({
        caller: 'terminal'
      });
      await expect(lstat(recovery)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('recovers a legacy abandoned recovery file only when its owner is confirmed absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-recovery-'));
    const cfg = config(root);
    const target = await endpoint(cfg);
    const old = {
      schemaVersion: 1,
      pid: 2147483647,
      processStartIdentity: 'old-absent-process',
      configHash: target.configHash,
      stateRoot: target.stateRoot,
      nonce: 'old-runtime'
    };
    await writeExclusive(target.lockPath, JSON.stringify(old));
    await writeExclusive(
      target.lockPath + '.recovery',
      JSON.stringify({ ...old, pid: 2147483646, nonce: 'old-recovery' })
    );
    let server: Awaited<ReturnType<typeof serveRuntime>> | undefined;
    try {
      server = await serveRuntime(cfg, { application: application() });
      expect(await (await BridgeClient.connect(cfg)).dispatch('engine.list')).toMatchObject({
        caller: 'terminal'
      });
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('serves a real Unix socket and binds caller identity from configured credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const server = await serveRuntime(cfg, { application: application() });
    try {
      expect(server.socketPath).toMatch(/runtime\.sock$/);
      expect((await lstat(server.socketPath)).mode & 0o777).toBe(0o600);
      const client = await BridgeClient.connect(cfg);
      expect(await client.dispatch('engine.list')).toEqual({
        caller: 'terminal',
        operation: 'engine.list',
        args: {}
      });
      expect((await lstat(join(root, 'clients', 'terminal.token'))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(root, 'runtime.lock.json'), 'utf8')).toContain(
        'processStartIdentity'
      );
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects spoofed roles, wrong credentials and unknown operations before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    let calls = 0;
    const app = application();
    app.dispatch = async () => {
      calls++;
      return {};
    };
    const server = await serveRuntime(cfg, { application: app });
    try {
      const target = await endpoint(cfg);
      const token = (
        JSON.parse(await readFile(join(root, 'clients', 'terminal.token'), 'utf8')) as {
          token: string;
        }
      ).token;
      const request = signRequest(
        {
          apiVersion: 'agent-bridge/v1',
          configHash: target.configHash,
          callerRef: 'terminal',
          bindingHash: digest(await readBinding(target.lockPath)),
          operation: 'engine.list',
          args: {}
        },
        token
      );
      expect(await raw(server.socketPath, { ...request, role: 'controller' })).toMatchObject({
        error: { code: 'INVALID_ARGUMENT' }
      });
      expect(await raw(server.socketPath, { ...request, proof: 'f'.repeat(64) })).toMatchObject({
        error: { code: 'AUTH_REQUIRED' }
      });
      expect(await raw(server.socketPath, { ...request, operation: 'run-shell' })).toMatchObject({
        error: { code: 'INVALID_ARGUMENT' }
      });
      expect(calls).toBe(0);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses incompatible config and live PID reuse without restarting or stealing a lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const server = await serveRuntime(cfg, { application: application() });
    try {
      await expect(BridgeClient.connect({ ...cfg, maxLogBytes: 4096 })).rejects.toThrow(
        /CONFIG_MISMATCH/
      );
      await expect(serveRuntime(cfg, { application: application() })).rejects.toThrow(
        /RUNTIME_BUSY/
      );
      const lock = JSON.parse(await readFile(join(root, 'runtime.lock.json'), 'utf8')) as Record<
        string,
        unknown
      >;
      await writeFile(
        join(root, 'runtime.lock.json'),
        JSON.stringify({ ...lock, processStartIdentity: 'reused-pid' }),
        { mode: 0o600 }
      );
      await expect(BridgeClient.connect(cfg)).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
      await expect(serveRuntime(cfg, { application: application() })).rejects.toThrow(
        /RUNTIME_BUSY/
      );
      await writeFile(join(root, 'runtime.lock.json'), JSON.stringify(lock), { mode: 0o600 });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('requires controller plus requestId for runtime.stop and cleans only its owned server', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    let stopped = 0;
    const app = application();
    app.close = async () => {
      stopped++;
    };
    const server = await serveRuntime(cfg, { application: app });
    try {
      await expect(
        (await BridgeClient.connect(cfg, { callerRef: 'worker' })).dispatch('runtime.stop', {
          requestId: 'stop-worker'
        })
      ).rejects.toThrow(/POLICY_DENIED/);
      const controller = await BridgeClient.connect(cfg);
      await expect(controller.dispatch('runtime.stop')).rejects.toThrow(/INVALID_ARGUMENT/);
      expect(await controller.dispatch('runtime.stop', { requestId: 'stop-controller' })).toEqual({
        stopping: true
      });
      await server.closed;
      expect(stopped).toBe(1);
      await expect(lstat(server.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(join(root, 'runtime.lock.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('continues app operations after a control client times out instead of cancelling registered work', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    let finished = false;
    let stopped = false;
    const app = application();
    app.dispatch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      finished = true;
      return {};
    };
    app.close = async () => {
      stopped = true;
    };
    const server = await serveRuntime(cfg, { application: app });
    try {
      const client = await BridgeClient.connect(cfg, { timeoutMs: 100 });
      await expect(
        client.dispatch('task.start', { requestId: 'never-replay' })
      ).rejects.toMatchObject({ code: 'CONNECTION_TIMEOUT', executionDisposition: 'unknown' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(finished).toBe(true);
      expect(stopped).toBe(false);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('recovers only a confirmed absent process with exact root/config binding', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const target = await endpoint(cfg);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const identity = await processIdentity(pid);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await writeExclusive(
      target.lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid,
        processStartIdentity: identity,
        configHash: target.configHash,
        stateRoot: target.stateRoot,
        nonce: 'stale-binding'
      })
    );
    const server = await serveRuntime(cfg, { application: application() });
    try {
      expect(await (await BridgeClient.connect(cfg)).dispatch('engine.list')).toMatchObject({
        caller: 'terminal'
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses state links and oversized RPC before dispatch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const server = await serveRuntime(cfg, { application: application() });
    try {
      const client = await BridgeClient.connect(cfg);
      await expect(
        client.dispatch('task.start', { objective: 'x'.repeat(4 * 1024 * 1024) })
      ).rejects.toThrow(/INPUT_LIMIT/);
      await rm(join(root, 'clients', 'terminal.token'));
      const outside = join(root, 'outside');
      await writeFile(outside, '{}', { mode: 0o600 });
      await symlink(outside, join(root, 'clients', 'terminal.token'));
      await expect(BridgeClient.connect(cfg)).rejects.toThrow(/STATE_UNSAFE|AUTH_REQUIRED/);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('bootstraps a confirmed absent runtime once without replaying a control mutation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const target = await endpoint(cfg);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const pid = child.pid!;
    const identity = await processIdentity(pid);
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
    await writeExclusive(
      target.lockPath,
      JSON.stringify({
        schemaVersion: 1,
        pid,
        processStartIdentity: identity,
        configHash: target.configHash,
        stateRoot: target.stateRoot,
        nonce: 'dead-runtime'
      })
    );
    let boots = 0;
    let calls = 0;
    let server: Awaited<ReturnType<typeof serveRuntime>> | undefined;
    const app = application();
    app.dispatch = async () => {
      calls++;
      return { registered: true };
    };
    try {
      const client = await BridgeClient.connect(cfg, {
        bootstrap: async () => {
          boots++;
          server = await serveRuntime(cfg, { application: app });
        }
      });
      expect(await client.dispatch('task.start', { requestId: 'original-id' })).toEqual({
        registered: true
      });
      expect(boots).toBe(1);
      expect(calls).toBe(1);
    } finally {
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('preserves structured error details and execution disposition through the control client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const app = application();
    app.dispatch = async () => {
      throw new BridgeError('SCOPE_CONFLICT', 'Bound scope conflict', 'not_started', {
        field: 'writeScope'
      });
    };
    const server = await serveRuntime(cfg, { application: app });
    try {
      const client = await BridgeClient.connect(cfg);
      await expect(client.dispatch('preflight')).rejects.toMatchObject({
        code: 'SCOPE_CONFLICT',
        message: 'SCOPE_CONFLICT: Bound scope conflict',
        executionDisposition: 'not_started',
        details: { field: 'writeScope' }
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('returns a bounded operation-matched OUTPUT_LIMIT instead of a malformed response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const app = application();
    app.dispatch = async () => ({ text: 'x'.repeat(4 * 1024 * 1024) });
    const server = await serveRuntime(cfg, { application: app });
    try {
      await expect((await BridgeClient.connect(cfg)).dispatch('engine.list')).rejects.toMatchObject(
        { code: 'OUTPUT_LIMIT', executionDisposition: 'unknown' }
      );
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('maps every control-client convenience method onto canonical wire operations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const server = await serveRuntime(cfg, { application: application() });
    try {
      const client = await BridgeClient.connect(cfg);
      const task = { taskId: 'task_11111111-1111-4111-8111-111111111111' };
      const calls: Array<[Promise<unknown>, string]> = [
        [client.engines.list(), 'engine.list'],
        [client.preflight({ engine: 'codex', projectId: 'sample' }), 'preflight'],
        [
          client.tasks.start({
            engine: 'codex',
            projectId: 'sample',
            requestId: 'req-start',
            taskSpec: {
              taskSpecVersion: '1',
              objective: 'Fixture',
              acceptanceCriteria: ['Done'],
              writeScope: ['src/**'],
              scopeReference: 'user:fixture'
            }
          }),
          'task.start'
        ],
        [client.tasks.get(task), 'task.get'],
        [client.tasks.list(), 'task.list'],
        [client.tasks.events(task), 'task.watch'],
        [
          client.tasks.continue({ ...task, requestId: 'req-continue', message: 'Continue scope' }),
          'task.continue'
        ],
        [client.tasks.cancel({ ...task, requestId: 'req-cancel' }), 'task.cancel'],
        [client.artifacts.list(task), 'artifact.list'],
        [client.artifacts.read({ ...task, artifactId: 'artifact-1' }), 'artifact.read']
      ];
      for (const [result, operation] of calls)
        expect(await result).toMatchObject({ caller: 'terminal', operation });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects shared-mode state, malformed bindings and undeclared client identities', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    try {
      await chmod(root, 0o755);
      await expect(serveRuntime(cfg, { application: application() })).rejects.toThrow(
        /STATE_UNSAFE/
      );
      await chmod(root, 0o700);
      const path = join(root, 'invalid.json');
      await writeFile(path, '{', { mode: 0o600 });
      await expect(readBinding(path)).rejects.toThrow(/STATE_CORRUPT/);
      await writeFile(path, '{}', { mode: 0o600 });
      await expect(readBinding(path)).rejects.toThrow(/STATE_CORRUPT/);
      await chmod(path, 0o644);
      await expect(readPrivate(path)).rejects.toThrow(/STATE_UNSAFE/);
      await expect(BridgeClient.connect(cfg, { callerRef: 'undeclared' })).rejects.toThrow(
        /AUTH_REQUIRED/
      );
      await expect(BridgeClient.connect(cfg)).rejects.toThrow(/RUNTIME_UNAVAILABLE/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('rejects mismatched RPC configuration and caller without dispatch and suppresses raw internal errors', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const app = application();
    app.dispatch = async () => {
      throw new Error('raw-token-must-not-be-disclosed');
    };
    const server = await serveRuntime(cfg, { application: app });
    try {
      const target = await endpoint(cfg);
      const token = (
        JSON.parse(await readFile(join(root, 'clients', 'terminal.token'), 'utf8')) as {
          token: string;
        }
      ).token;
      const request = signRequest(
        {
          apiVersion: 'agent-bridge/v1',
          configHash: target.configHash,
          callerRef: 'terminal',
          bindingHash: digest(await readBinding(target.lockPath)),
          operation: 'engine.list',
          args: {}
        },
        token
      );
      expect(
        await raw(server.socketPath, { ...request, configHash: 'other-config' })
      ).toMatchObject({ error: { code: 'CONFIG_MISMATCH' } });
      expect(await raw(server.socketPath, { ...request, callerRef: 'unregistered' })).toMatchObject(
        { error: { code: 'AUTH_REQUIRED' } }
      );
      expect(await raw(server.socketPath, null)).toMatchObject({
        error: { code: 'INVALID_ARGUMENT' }
      });
      const reply = await raw(server.socketPath, request);
      expect(reply).toMatchObject({ error: { code: 'INTERNAL', executionDisposition: 'unknown' } });
      expect(JSON.stringify(reply)).not.toContain('raw-token');
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('uses the real default application only for an empty task.list control operation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ipc-'));
    const cfg = config(root);
    const server = await serveRuntime(cfg);
    try {
      expect(await (await BridgeClient.connect(cfg)).tasks.list()).toMatchObject({
        tasks: [],
        nextCursor: null
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
