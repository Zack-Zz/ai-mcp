import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { serveRuntime } from '../src/runtime/ipc.js';
import { BridgeClient } from '../src/client/index.js';
import { parseConfig } from '../src/contracts/validation.js';
import * as security from '../src/client/security.js';
import {
  signRequest,
  signReply,
  verifyRequest,
  verifyReply,
  ReplayWindow
} from '../src/client/authentication.js';
import { digest } from '../src/runtime/journal.js';
import { MAX_FRAME_BYTES, type RpcRequest } from '../src/client/protocol.js';

function signed(token = 'fixture-caller-secret') {
  return signRequest(
    {
      apiVersion: 'agent-bridge/v1',
      configHash: 'config-fixture',
      callerRef: 'host',
      bindingHash: 'a'.repeat(64),
      operation: 'task.start',
      args: { requestId: 'original-write' }
    },
    token
  );
}

async function raw(path: string, request: RpcRequest): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    let buffer = '';
    socket.on('error', reject);
    socket.once('connect', () => socket.write(JSON.stringify(request) + '\n'));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes('\n')) {
        socket.destroy();
        resolve(JSON.parse(buffer.trim()) as Record<string, unknown>);
      }
    });
  });
}

describe('Sandboxed Bridge control client', () => {
  it('waits for a private binding to finish publishing without bootstrapping over it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-publishing-binding-'));
    const config = parseConfig({
      schemaVersion: 1,
      stateRoot: root,
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { codex: { command: 'codex' } },
      clients: [{ id: 'host', role: 'controller' }]
    });
    const server = await serveRuntime(config, {
      application: {
        async dispatch() {
          return { ready: true };
        },
        async close() {},
        async idle() {}
      }
    });
    const target = await security.endpoint(config);
    const committed = await readFile(target.lockPath, 'utf8');
    await writeFile(target.lockPath, '', { mode: 0o600 });
    const publish = (async () => {
      await new Promise((resolve) => setTimeout(resolve, 75));
      await writeFile(target.lockPath, committed, { mode: 0o600 });
    })();
    const bootstrap = vi.fn(async () => {});
    try {
      const client = await BridgeClient.connect(config, { callerRef: 'host', bootstrap });
      expect(await client.engines.list()).toEqual({ ready: true });
      expect(bootstrap).not.toHaveBeenCalled();
    } finally {
      await publish;
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('enforces a wall-clock RPC bound when an untrusted peer dribbles an incomplete response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-slow-peer-'));
    const config = parseConfig({
      schemaVersion: 1,
      stateRoot: root,
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { codex: { command: 'codex' } },
      clients: [{ id: 'host', role: 'controller' }]
    });
    const runtime = await serveRuntime(config, {
      application: {
        async dispatch() {
          return {};
        },
        async close() {},
        async idle() {}
      }
    });
    const clients = new Set<Socket>();
    const fake = createServer((socket) => {
      clients.add(socket);
      const interval = setInterval(() => socket.write(' '), 20);
      socket.on('close', () => {
        clearInterval(interval);
        clients.delete(socket);
      });
    });
    try {
      const client = await BridgeClient.connect(config, { callerRef: 'host', timeoutMs: 100 });
      await runtime.close();
      const target = await security.endpoint(config);
      await new Promise<void>((resolve) => fake.listen(target.socketPath, resolve));
      const result = await Promise.race([
        client.engines.list().catch((error) => error as unknown),
        new Promise((resolve) => setTimeout(() => resolve('missed-deadline'), 300))
      ]);
      expect(result).toMatchObject({ code: 'CONNECTION_TIMEOUT', executionDisposition: 'unknown' });
    } finally {
      for (const socket of clients) socket.destroy();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('waits for authenticated readiness after an absent daemon leaves a stale private socket', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-stale-socket-'));
    const config = parseConfig({
      schemaVersion: 1,
      stateRoot: root,
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { codex: { command: 'codex' } },
      clients: [{ id: 'host', role: 'controller' }]
    });
    const target = await security.endpoint(config);
    await security.credential(target, config.clients[0]!, true);
    const child = spawn(
      process.execPath,
      [
        '-e',
        "const net=require('node:net'),fs=require('node:fs');net.createServer(()=>{}).listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.stdout.write('ready');});",
        target.socketPath
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let server: Awaited<ReturnType<typeof serveRuntime>> | undefined;
    let startup: Promise<void> | undefined;
    try {
      await once(child.stdout!, 'data');
      const exited = once(child, 'exit');
      child.kill('SIGKILL');
      await exited;
      await security.writeExclusive(
        target.lockPath,
        JSON.stringify({
          schemaVersion: 1,
          pid: child.pid,
          processStartIdentity: 'absent-old-daemon',
          configHash: target.configHash,
          stateRoot: target.stateRoot,
          nonce: 'old-runtime'
        })
      );
      const bootstrap = vi.fn(async () => {
        startup = (async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          server = await serveRuntime(config, {
            application: {
              async dispatch() {
                return { ready: true };
              },
              async close() {},
              async idle() {}
            }
          });
        })();
      });
      const client = await BridgeClient.connect(config, { callerRef: 'host', bootstrap });
      expect(await client.engines.list()).toEqual({ ready: true });
      expect(bootstrap).toHaveBeenCalledTimes(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await startup;
      await server?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('authenticates an existing daemon without process inspection or a replacement bootstrap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-sandbox-client-'));
    const config = parseConfig({
      schemaVersion: 1,
      stateRoot: root,
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { codex: { command: 'codex' } },
      clients: [{ id: 'host', role: 'controller' }]
    });
    let operations = 0;
    const server = await serveRuntime(config, {
      application: {
        async dispatch(caller, operation) {
          operations++;
          return { caller, operation };
        },
        async close() {},
        async idle() {}
      }
    });
    const inspection = vi.spyOn(security, 'processIdentity').mockResolvedValue(null);
    const realKill = process.kill.bind(process);
    const signal = vi.spyOn(process, 'kill').mockImplementation((pid, name) => {
      if (name === 0)
        throw Object.assign(new Error('Process inspection denied'), { code: 'EPERM' });
      return realKill(pid, name);
    });
    const bootstrap = vi.fn(async () => {});
    try {
      const client = await BridgeClient.connect(config, { callerRef: 'host', bootstrap });
      expect(await client.engines.list()).toEqual({ caller: 'host', operation: 'engine.list' });
      expect(bootstrap).not.toHaveBeenCalled();
      expect(inspection).not.toHaveBeenCalled();
      expect(operations).toBe(1);
    } finally {
      inspection.mockRestore();
      signal.mockRestore();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rejects request tampering and other caller credentials without exposing the token on the wire', () => {
    const request = signed();
    expect(JSON.stringify(request)).not.toContain('fixture-caller-secret');
    expect(() => verifyRequest(request, 'fixture-caller-secret')).not.toThrow();
    expect(() =>
      verifyRequest({ ...request, args: { requestId: 'another-write' } }, 'fixture-caller-secret')
    ).toThrow(/AUTH_REQUIRED/);
    expect(() =>
      verifyRequest({ ...request, callerRef: 'controller' }, 'fixture-caller-secret')
    ).toThrow(/AUTH_REQUIRED/);
    expect(() => verifyRequest(request, 'other-caller-secret')).toThrow(/AUTH_REQUIRED/);
  });

  it('treats unsigned, tampered, wrong-key and replayed responses as unknown', () => {
    const request = signed();
    const reply = {
      apiVersion: 'agent-bridge/v1' as const,
      operation: 'task.start',
      requestId: 'original-write',
      data: { registered: true }
    };
    const response = signReply(reply, request, 'fixture-caller-secret', request.bindingHash);
    expect(verifyReply(response, request, 'fixture-caller-secret')).toEqual(reply);
    for (const bad of [
      reply,
      null,
      { ...response, data: { registered: false } },
      { ...response, controlProof: { ...response.controlProof, proof: '0'.repeat(64) } }
    ]) {
      try {
        verifyReply(bad, request, 'fixture-caller-secret');
        throw new Error('Accepted forged response');
      } catch (error) {
        expect(error).toMatchObject({ code: 'PROTOCOL_ERROR', executionDisposition: 'unknown' });
      }
    }
    expect(() => verifyReply(response, request, 'another-key')).toThrow(/PROTOCOL_ERROR/);
    expect(() => verifyReply(response, signed(), 'fixture-caller-secret')).toThrow(
      /PROTOCOL_ERROR/
    );
    const changed = signReply(reply, request, 'fixture-caller-secret', 'b'.repeat(64));
    try {
      verifyReply(changed, request, 'fixture-caller-secret');
      throw new Error('Accepted another runtime');
    } catch (error) {
      expect(error).toMatchObject({ code: 'RUNTIME_UNAVAILABLE', executionDisposition: 'unknown' });
    }
  });

  it('retains valid consumed nonces when full and does not revive them after a backwards clock change', () => {
    const window = new ReplayWindow(1);
    const request = signed();
    const now = request.issuedAtMs;
    window.consume(request, now);
    expect(() => window.consume(request, now)).toThrow(/REPLAY_REJECTED/);
    expect(() => window.consume(signed(), now)).toThrow(/RATE_LIMITED/);
    const fresh = { ...request, challenge: 'b'.repeat(64), issuedAtMs: now + 31000 };
    window.consume(fresh, now + 31000);
    expect(() => window.consume(request, now)).toThrow(/REPLAY_REJECTED/);
    expect(() =>
      window.consume({ ...fresh, challenge: 'c'.repeat(64), issuedAtMs: now + 37000 }, now + 31000)
    ).toThrow(/REPLAY_REJECTED/);
  });

  it('consumes an authenticated concurrent replay once before dispatch and rejects changed arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-replay-client-'));
    const config = parseConfig({
      schemaVersion: 1,
      stateRoot: root,
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { codex: { command: 'codex' } },
      clients: [{ id: 'host', role: 'controller' }]
    });
    let calls = 0;
    const server = await serveRuntime(config, {
      application: {
        async dispatch() {
          calls++;
          await new Promise((resolve) => setTimeout(resolve, 10));
          return { registered: true };
        },
        async close() {},
        async idle() {}
      }
    });
    try {
      const target = await security.endpoint(config);
      const token = (
        JSON.parse(await readFile(join(root, 'clients/host.token'), 'utf8')) as { token: string }
      ).token;
      const request = signRequest(
        {
          apiVersion: 'agent-bridge/v1',
          configHash: target.configHash,
          callerRef: 'host',
          bindingHash: digest(await security.readBinding(target.lockPath)),
          operation: 'task.start',
          args: { requestId: 'original-write' }
        },
        token
      );
      const replies = await Promise.all([
        raw(server.socketPath, request),
        raw(server.socketPath, request)
      ]);
      expect(replies.filter((reply) => 'data' in reply)).toHaveLength(1);
      expect(replies.find((reply) => 'error' in reply)).toMatchObject({
        error: { code: 'REPLAY_REJECTED', executionDisposition: 'unknown' }
      });
      expect(calls).toBe(1);
      expect(
        await raw(server.socketPath, { ...request, args: { requestId: 'unauthorized-write' } })
      ).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
      expect(calls).toBe(1);
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('bounds the final authenticated wire frame even when the unsigned result fits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-signed-limit-'));
    const config = parseConfig({
      schemaVersion: 1,
      stateRoot: root,
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { codex: { command: 'codex' } },
      clients: [{ id: 'host', role: 'controller' }]
    });
    const data = { text: 'x'.repeat(MAX_FRAME_BYTES - 100) };
    expect(
      Buffer.byteLength(
        JSON.stringify({ apiVersion: 'agent-bridge/v1', operation: 'engine.list', data }) + '\n'
      )
    ).toBeLessThan(MAX_FRAME_BYTES);
    const server = await serveRuntime(config, {
      application: {
        async dispatch() {
          return data;
        },
        async close() {},
        async idle() {}
      }
    });
    try {
      const client = await BridgeClient.connect(config, { callerRef: 'host' });
      await expect(client.engines.list()).rejects.toMatchObject({
        code: 'OUTPUT_LIMIT',
        executionDisposition: 'unknown'
      });
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
