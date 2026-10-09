import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EngineEvent, LaunchInput } from '../src/contracts/types.js';
import { launchCodexAppServer } from '../src/adapters/app-server.js';
const fixture = fileURLToPath(new URL('./fixtures/app-server-engine.mjs', import.meta.url));
const sessionId = '12345678-1234-4234-9234-123456789abc';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function setup(mode = 'normal', extra: Partial<LaunchInput> = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'bridge-appserver-'));
  dirs.push(cwd);
  const input: LaunchInput = {
    runId: 'run_test',
    cwd,
    prompt: '--model literal 世界',
    permissionProfile: 'workspace-write',
    config: {
      command: process.execPath,
      args: [fixture],
      env: {
        FIXTURE_MODE: mode,
        FIXTURE_LOG: join(cwd, 'rpc.jsonl'),
        FIXTURE_CHILD_PID: join(cwd, 'child.pid'),
        AGENT_BRIDGE_TEST_SECRET: 'bridge-control',
        CODEX_SANDBOX: 'seatbelt'
      },
      pluginDirs: []
    },
    timeoutMs: 1000,
    maxLogBytes: 20000,
    ...extra
  };
  return {
    input,
    log: async () =>
      (await readFile(join(cwd, 'rpc.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
  };
}
async function run(
  mode = 'normal',
  extra: Partial<LaunchInput> = {},
  observe?: (e: EngineEvent) => void
) {
  const s = await setup(mode, extra);
  const events: EngineEvent[] = [];
  const handle = await launchCodexAppServer(s.input, observe ?? ((e) => events.push(e)));
  return { ...s, handle, events, outcome: await handle.result };
}
describe('Codex app-server owned lifecycle', () => {
  it('starts one persistent native root and completes only after clean group shutdown', async () => {
    const r = await run();
    expect(r.outcome).toMatchObject({
      status: 'completed',
      sessionId,
      exitCode: 0,
      processGroupExited: true,
      executionStopped: true,
      executionDisposition: 'completed',
      message: '世界 done'
    });
    expect(() => process.kill(-r.handle.pid!, 0)).toThrow();
    const log = await r.log();
    expect(log[0]).toMatchObject({
      args: ['app-server', '--listen', 'stdio://'],
      bridge: false,
      sandbox: false
    });
    const start = log.find((x) => x.method === 'thread/start')!;
    expect(start.params).toEqual({
      cwd: r.input.cwd,
      sandbox: 'workspace-write',
      ephemeral: false
    });
    expect(log.find((x) => x.method === 'turn/start')!.params).toEqual({
      threadId: sessionId,
      input: [{ type: 'text', text: r.input.prompt, text_elements: [] }]
    });
    expect(r.events.filter((x) => x.kind === 'message').map((x) => x.data)).not.toContainEqual({
      text: 'foreign'
    });
    expect(r.events.some((x) => x.kind === 'usage')).toBe(true);
    expect(r.events.some((x) => x.kind === 'tool')).toBe(true);
  });
  it('retains same-turn native retry without resending task input and emits safe diagnostics', async () => {
    const r = await run('retry-error');
    expect(r.outcome.status).toBe('completed');
    expect((await r.log()).filter((x) => x.method === 'turn/start')).toHaveLength(1);
    const diagnostics = JSON.stringify(r.events.filter((e) => e.kind === 'diagnostic'));
    expect(diagnostics).toContain('Upstream unavailable');
    expect(diagnostics).toContain('serverOverloaded');
    expect(diagnostics).not.toContain('top-secret-value');
    expect(diagnostics).not.toContain('forbidden-secret-field');
  });
  it('stops for a final same-turn error and retains its safe native cause', async () => {
    const r = await run('fatal-error');
    expect(r.outcome).toMatchObject({
      status: 'failed',
      executionDisposition: 'unknown',
      processGroupExited: true
    });
    expect(r.outcome.message).toContain('Upstream unavailable');
    expect(r.outcome.message).toContain('serverOverloaded');
    expect(JSON.stringify({ outcome: r.outcome, events: r.events })).not.toMatch(
      /top-secret-value|forbidden-secret-field/
    );
  });
  for (const mode of ['rpc-auth-error', 'turn-auth-error'])
    it(`preserves native public code/message for ${mode} without raw error fields`, async () => {
      const r = await run(mode);
      expect(r.outcome.status).toBe('failed');
      const safe = JSON.stringify({ outcome: r.outcome, events: r.events });
      expect(safe.toLowerCase()).toContain('authentication unavailable');
      expect(safe).toContain(mode === 'rpc-auth-error' ? '-1' : 'unauthorized');
      expect(safe).not.toMatch(
        /top-secret-value|forbidden-secret-field|additionalDetails|authorization/
      );
    });
  it('does not fill the pending turn-event queue with unrelated native startup notifications', async () => {
    const r = await run('startup-noise', { maxLogBytes: 100000 });
    expect(r.outcome.status).toBe('completed');
    expect((await r.log()).filter((x) => x.method === 'turn/start')).toHaveLength(1);
  });
  it('accepts normal native SIGINT shutdown when EOF alone leaves the server alive', async () => {
    const r = await run('wait-sigint');
    expect(r.outcome).toMatchObject({
      status: 'completed',
      exitCode: 0,
      signal: null,
      processGroupExited: true
    });
    expect((await r.log()).filter((x) => x.shutdown).map((x) => x.shutdown)).toEqual([
      'EOF',
      'SIGINT'
    ]);
  });
  it('resumes the exact registered root without a replacement start', async () => {
    const r = await run('normal', { sessionId });
    expect(r.outcome.status).toBe('completed');
    const log = await r.log();
    expect(log.find((x) => x.method === 'thread/resume')!.params).toEqual({
      threadId: sessionId,
      cwd: r.input.cwd,
      sandbox: 'workspace-write',
      excludeTurns: true
    });
    expect(log.some((x) => x.method === 'thread/start')).toBe(false);
  });
  for (const mode of ['wrong-id', 'wrong-cwd', 'busy', 'child-session'])
    it(`refuses ${mode} before task input is sent`, async () => {
      const r = await run(mode, { sessionId });
      expect(r.outcome).toMatchObject({
        status: 'failed',
        executionDisposition: 'unknown',
        processGroupExited: true
      });
      expect((await r.log()).some((x) => x.method === 'turn/start')).toBe(false);
    });
  for (const mode of [
    'early-exit',
    'wrong-turn',
    'wrong-thread',
    'failed-turn',
    'rpc-error',
    'wrong-response',
    'bad-json',
    'bad-utf8'
  ])
    it(`cannot infer completion from ${mode}`, async () => {
      expect((await run(mode, { timeoutMs: 180 })).outcome).toMatchObject({
        status: 'failed',
        executionDisposition: 'unknown',
        processGroupExited: true
      });
    });
  for (const mode of ['chunks', 'early-terminal'])
    it(`accepts correlated ${mode} frames`, async () => {
      expect((await run(mode)).outcome.status).toBe('completed');
    });
  for (const mode of ['approval', 'unknown-request'])
    it(`refuses server ${mode} without approval authority`, async () => {
      const r = await run(mode);
      expect(r.outcome.status).toBe('failed');
      expect((await r.log()).find((x) => x.id === 900)).toHaveProperty('error');
    });
  it('bounds total logs and timeout, including pending initialization', async () => {
    expect((await run('log-limit', { maxLogBytes: 1000 })).outcome.status).toBe('failed');
    expect((await run('hang-init', { timeoutMs: 120 })).outcome.status).toBe('failed');
  });
  for (const mode of ['pending-turn', 'hang-turn'])
    it(`interrupts ${mode} without replaying pending RPC`, async () => {
      const s = await setup(mode);
      const events: EngineEvent[] = [];
      const h = await launchCodexAppServer(s.input, (e) => events.push(e));
      for (let n = 0; n < 50; n++) {
        try {
          if ((await s.log()).some((x) => x.method === 'turn/start')) break;
        } catch {
          /* Fixture may not have opened its log yet. */
        }
        await new Promise((r) => setTimeout(r, 10));
      }
      await h.interrupt();
      expect(await h.result).toMatchObject({
        status: 'cancelled',
        processGroupExited: true,
        executionStopped: true,
        executionDisposition: 'unknown'
      });
      const log = await s.log();
      expect(log.filter((x) => x.method === 'turn/start')).toHaveLength(1);
      if (mode === 'hang-turn')
        expect(log.find((x) => x.method === 'turn/interrupt')!.params).toEqual({
          threadId: sessionId,
          turnId: 'turn-owned'
        });
    });
  for (const mode of ['orphan', 'ignore-shutdown'])
    it(`cleans ${mode} without publishing success after forced termination`, async () => {
      const r = await run(mode);
      expect(r.outcome).toMatchObject({
        status: 'failed',
        executionDisposition: 'unknown',
        processGroupExited: true,
        executionStopped: true
      });
      expect(() => process.kill(-r.handle.pid!, 0)).toThrow();
    });
  it('scrubs native logs/messages/usage and contains observer exceptions', async () => {
    const r = await run('secrets');
    expect(r.outcome.status).toBe('completed');
    expect(JSON.stringify(r.events)).not.toContain('top-secret-value');
    expect(JSON.stringify(r.outcome)).not.toContain('top-secret-value');
    expect(
      (
        await run('normal', {}, () => {
          throw new Error('observer');
        })
      ).outcome.status
    ).toBe('failed');
  });
  it('rejects read-only, malformed continuation and launcher controls before spawn', async () => {
    for (const extra of [{ permissionProfile: 'read-only' } as const, { sessionId: '--last' }]) {
      const s = await setup('normal', extra);
      await expect(launchCodexAppServer(s.input, () => {})).rejects.toThrow();
      await expect(s.log()).rejects.toThrow();
    }
    const s = await setup();
    s.input.config.args.push('--model');
    await expect(launchCodexAppServer(s.input, () => {})).rejects.toThrow();
  });
  it('does not publish completion while inherited RPC output remains undrained after owned group exit', async () => {
    const r = await run('pipe-tail');
    expect(r.outcome).toMatchObject({
      status: 'failed',
      executionDisposition: 'unknown',
      processGroupExited: true,
      executionStopped: false
    });
    // The escaped fixture helper is not the adapter's process group. Let its timer exit.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const pid = Number(await readFile(join(r.input.cwd, 'child.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
  });
  it('does not label cancellation stopped while a registered escaped pipe holder remains active', async () => {
    const s = await setup('pipe-tail-hang');
    s.input.config.env.FIXTURE_TAIL_MS = '15000';
    const h = await launchCodexAppServer(s.input, () => {});
    let pid = 0;
    try {
      for (let n = 0; n < 100 && !pid; n++) {
        try {
          pid = Number(await readFile(join(s.input.cwd, 'child.pid'), 'utf8'));
        } catch {
          /* Wait for our registered helper. */
        }
        if (!pid) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(pid).toBeGreaterThan(0);
      await h.interrupt();
      expect(await h.result).toMatchObject({
        status: 'failed',
        executionDisposition: 'unknown',
        processGroupExited: true,
        executionStopped: false
      });
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      // This PID belongs to the helper created and registered by this test fixture.
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* Already exited. */
        }
      }
      await h.interrupt();
    }
  });
  it('coalesces simultaneous cancellation without replaying turn/interrupt', async () => {
    const s = await setup('hang-turn');
    let seen = false;
    const h = await launchCodexAppServer(s.input, (e) => {
      if (e.kind === 'session') seen = true;
    });
    for (let n = 0; n < 100; n++) {
      if (seen && (await s.log()).some((x) => x.method === 'turn/start')) {
        await new Promise((r) => setTimeout(r, 10));
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    await Promise.all([h.interrupt(), h.interrupt()]);
    expect((await s.log()).filter((x) => x.method === 'turn/interrupt')).toHaveLength(1);
    expect((await h.result).status).toBe('cancelled');
  });
  it('returns not_started for preabort and spawn failure', async () => {
    const abort = new AbortController();
    abort.abort();
    expect((await run('normal', { signal: abort.signal })).outcome).toMatchObject({
      status: 'cancelled',
      executionDisposition: 'not_started'
    });
    const s = await setup();
    s.input.config.command = '/tmp/nonexistent-bridge-appserver';
    const h = await launchCodexAppServer(s.input, () => {});
    expect(await h.result).toMatchObject({ status: 'failed', executionDisposition: 'not_started' });
  });
});
