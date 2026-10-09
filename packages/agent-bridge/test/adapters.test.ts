import { describe, expect, it } from 'vitest';
import { createAdapters } from '../src/adapters/index.js';
import { nativeEnvironment } from '../src/adapters/environment.js';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { EngineEvent, LaunchInput } from '../src/contracts/types.js';
import type { EngineId } from '../src/contracts/validation.js';
import { EventDecoder } from '../src/adapters/events.js';
import { nativeArgs } from '../src/adapters/native.js';

const engines: EngineId[] = ['claude-code', 'zcode', 'codex'];
const fixture = fileURLToPath(new URL('./fixtures/engine-stream.mjs', import.meta.url));
function input(engine: EngineId, mode = 'normal', extra: Partial<LaunchInput> = {}): LaunchInput {
  return {
    runId: 'run_fixture',
    cwd: tmpdir(),
    prompt: 'Literal `shell` $(not executed) 世界',
    permissionProfile: 'workspace-write',
    config: {
      command: process.execPath,
      args: [fixture],
      env: { FIXTURE_ENGINE: engine, FIXTURE_MODE: mode },
      pluginDirs: [],
      ...(engine === 'codex' ? { codexTransport: 'exec' as const } : {})
    },
    timeoutMs: 3000,
    maxLogBytes: 20000,
    ...extra
  };
}
async function run(engine: EngineId, mode: string, extra: Partial<LaunchInput> = {}) {
  const events: EngineEvent[] = [];
  const handle = await createAdapters()
    .get(engine)!
    .launch(input(engine, mode, extra), (event) => events.push(event));
  return { handle, outcome: await handle.result, events };
}

describe('native engine adapters', () => {
  it('routes the default Codex profile through one published app-server root and literal JSON turn rather than exec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-default-codex-'));
    try {
      const launch = input('codex', 'normal', { cwd: dir });
      launch.config.args = [
        fileURLToPath(new URL('./fixtures/app-server-engine.mjs', import.meta.url))
      ];
      launch.config.env = { FIXTURE_LOG: join(dir, 'rpc.jsonl') };
      delete launch.config.codexTransport;
      const handle = await createAdapters()
        .get('codex')!
        .launch(launch, () => {});
      expect(await handle.result).toMatchObject({ status: 'completed', processGroupExited: true });
      const log = (await readFile(join(dir, 'rpc.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(log.filter((entry) => entry.method === 'thread/start')).toHaveLength(1);
      expect(log.filter((entry) => entry.method === 'thread/resume')).toHaveLength(0);
      const turn = log.find((entry) => entry.method === 'turn/start')!;
      expect(turn.params).toMatchObject({ input: [{ type: 'text', text: launch.prompt }] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('probes the default Codex app-server interface without creating a root or starting a turn', async () => {
    const launch = input('codex');
    launch.config.args = [
      fileURLToPath(new URL('./fixtures/app-server-engine.mjs', import.meta.url))
    ];
    delete launch.config.codexTransport;
    expect(await createAdapters().get('codex')!.probe(launch.config)).toMatchObject({
      available: true,
      evidence: 'interface-only',
      capabilities: {
        newSession: 'supported',
        continueSession: 'supported',
        structuredEvents: 'supported'
      }
    });
  });
  it('isolates root native sessions from inherited host sessions, IPC authority and enclosing sandbox markers', () => {
    const launch = input('codex');
    Object.assign(launch.config.env, {
      CODEX_SANDBOX: 'seatbelt',
      CODEX_SANDBOX_NETWORK_DISABLED: '1',
      CODEX_THREAD_ID: 'current-thread',
      CODEX_SESSION_ID: 'current-session',
      CODEX_APP_TOOLS_PIPE_PATH: '/tmp/current-app-control',
      CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY: 'current-attestation',
      ANTHROPIC_API_KEY: 'provider-auth',
      CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop'
    });
    const environment = nativeEnvironment(launch.config);
    expect(environment.CODEX_SANDBOX).toBeUndefined();
    expect(environment.CODEX_THREAD_ID).toBeUndefined();
    expect(environment.CODEX_SESSION_ID).toBeUndefined();
    expect(environment.CODEX_SANDBOX_NETWORK_DISABLED).toBeUndefined();
    expect(environment.CODEX_APP_TOOLS_PIPE_PATH).toBeUndefined();
    expect(environment.CODEX_TASK_WORKSPACE_VERIFYING_IDENTITY).toBeUndefined();
    expect(environment.ANTHROPIC_API_KEY).toBe('provider-auth');
    expect(environment.CODEX_INTERNAL_ORIGINATOR_OVERRIDE).toBe('Codex Desktop');
  });
  it('registers all three explicit canonical engine drivers', () => {
    expect([...createAdapters().keys()]).toEqual(['claude-code', 'zcode', 'codex']);
  });
  for (const engine of engines) {
    it(`${engine}: completes only from real session and terminal evidence`, async () => {
      const { outcome, events } = await run(engine, 'normal');
      expect(outcome).toMatchObject({
        status: 'completed',
        exitCode: 0,
        executionDisposition: 'completed'
      });
      expect(outcome.sessionId).toBeTruthy();
      expect(events.some((event) => event.kind === 'session')).toBe(true);
      expect(events.some((event) => event.kind === 'message')).toBe(true);
      expect(events.some((event) => event.kind === 'usage')).toBe(true);
      expect(outcome.usage).toEqual(engine === 'zcode' ? { inputTokens: 3 } : { input_tokens: 3 });
    });
    it(`${engine}: preserves exact session continuation`, async () => {
      const sessionId =
        engine === 'zcode' ? 'sess_existing' : '12345678-1234-4234-9234-123456789abc';
      expect((await run(engine, 'normal', { sessionId })).outcome).toMatchObject({
        status: 'completed',
        sessionId
      });
    });
    it(`${engine}: parses split UTF8 and final non-newline JSON`, async () => {
      expect((await run(engine, 'chunks')).outcome.status).toBe('completed');
    });
    for (const mode of ['fake', 'bad', 'missing-session', 'failure', 'mismatch']) {
      it(`${engine}: refuses ${mode} as completion`, async () => {
        expect(
          (
            await run(
              engine,
              mode,
              mode === 'mismatch'
                ? {
                    sessionId:
                      engine === 'zcode' ? 'sess_expected' : '12345678-1234-4234-9234-123456789abc'
                  }
                : {}
            )
          ).outcome
        ).toMatchObject({ status: 'failed', executionDisposition: 'unknown' });
      });
    }
    it(`${engine}: terminates timeout and bounds log output`, async () => {
      expect((await run(engine, 'hang', { timeoutMs: 100 })).outcome).toMatchObject({
        status: 'failed',
        executionDisposition: 'unknown'
      });
      expect((await run(engine, 'loglimit', { maxLogBytes: 1024 })).outcome).toMatchObject({
        status: 'failed',
        executionDisposition: 'unknown'
      });
    });
    it(`${engine}: strips sensitive fields and diagnostic credentials`, async () => {
      const result = await run(engine, 'secrets');
      expect(result.events.some((event) => event.kind === 'diagnostic')).toBe(true);
      expect(JSON.stringify(result)).not.toContain('top-secret-value');
      expect(JSON.stringify(result)).not.toContain('api_key');
    });
    it(`${engine}: probes interface with help/version without launching model`, async () => {
      const probe = await createAdapters().get(engine)!.probe(input(engine).config);
      expect(probe).toMatchObject({
        available: true,
        version: 'fixture 1.0',
        evidence: 'interface-only',
        capabilities: {
          newSession: 'supported',
          continueSession: 'supported',
          structuredEvents: 'supported',
          cancel: 'unverified',
          readOnly: engine === 'codex' ? 'unsupported' : 'unverified'
        }
      });
    });
    it(`${engine}: passes literal argv, exact cwd and explicit permissions`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bridge-argv-'));
      try {
        const launch = input(engine, 'normal', {
          cwd: dir,
          permissionProfile: engine === 'codex' ? 'workspace-write' : 'read-only'
        });
        launch.config.env.FIXTURE_ARGV_FILE = join(dir, 'argv.json');
        const handle = await createAdapters()
          .get(engine)!
          .launch(launch, () => {});
        await handle.result;
        const actual = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as {
          args: string[];
          cwd: string;
        };
        expect(actual.cwd).toBe(await realpath(dir));
        expect(actual.args).toContain(launch.prompt);
        expect(actual.args.join(' ')).not.toMatch(/yolo|bypass|--last|--ephemeral/);
        if (engine === 'claude-code') {
          expect(actual.args).toContain('--tools');
          expect(actual.args).toContain('Read,Glob,Grep,Skill');
        }
        if (engine === 'zcode') {
          expect(actual.args).toContain('plan');
          expect(actual.args).toContain('Bash,Edit,Write');
        }
        if (engine === 'codex') {
          expect(actual.args.slice(0, 4)).toEqual([
            'exec',
            '--json',
            '--sandbox',
            'workspace-write'
          ]);
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
  it('allows Claude Skill in the write pool without granting skill-supplied shell, Agent or MCP tools', () => {
    const args = nativeArgs('claude-code', input('claude-code'));
    expect(args[args.indexOf('--tools') + 1]).toBe('Read,Glob,Grep,Skill,Edit,Write');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('Read,Glob,Grep,Skill,Edit,Write');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Bash');
    expect(args[args.indexOf('--tools') + 1]).not.toMatch(/Bash|Agent|mcp/);
  });
  it('preserves Codex native file-reading tools and applies its real sandbox profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-shell-'));
    try {
      const launch = input('codex');
      launch.config.env.FIXTURE_ARGV_FILE = join(dir, 'argv.json');
      await (
        await createAdapters()
          .get('codex')!
          .launch(launch, () => {})
      ).result;
      const { args } = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as {
        args: string[];
      };
      expect(args).not.toContain('features.shell_tool=false');
      expect(args).not.toContain('features.unified_exec=false');
      expect(args).toContain('workspace-write');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('does not require feature-disable flags to use Codex native sandbox', async () => {
    expect(
      (
        await (
          await createAdapters()
            .get('codex')!
            .launch(input('codex', 'no-shell-control'), () => {})
        ).result
      ).status
    ).toBe('completed');
  });
  it('refuses Codex read-only execution before spawning because native apply_patch is not constrained by its shell sandbox', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-read-only-codex-'));
    try {
      const launch = input('codex', 'normal', { permissionProfile: 'read-only' });
      launch.config.env.FIXTURE_ARGV_FILE = join(dir, 'launched.json');
      await expect(
        createAdapters()
          .get('codex')!
          .launch(launch, () => {})
      ).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
      await expect(readFile(join(dir, 'launched.json'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await createAdapters().get('codex')!.probe(launch.config)).capabilities.readOnly
      ).toBe('unsupported');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  for (const mode of ['missing-terminal-status', 'busy-terminal']) {
    it(`rejects ZCode ${mode} as a completed turn`, async () => {
      expect((await run('zcode', mode)).outcome.status).toBe('failed');
    });
  }
  it('cancels the owned process group including a child that ignores graceful signals', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-tree-'));
    try {
      const launch = input('codex', 'tree');
      launch.config.env.FIXTURE_PID_FILE = join(dir, 'child.pid');
      const handle = await createAdapters()
        .get('codex')!
        .launch(launch, () => {});
      let childPid = 0;
      for (let count = 0; count < 100 && !childPid; count++) {
        try {
          childPid = Number(await readFile(join(dir, 'child.pid'), 'utf8'));
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      expect(childPid).toBeGreaterThan(0);
      await handle.interrupt();
      expect(await handle.result).toMatchObject({
        status: 'cancelled',
        executionDisposition: 'unknown'
      });
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('does not publish completion while a background descendant still owns the process group', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-orphan-'));
    let pid: number | undefined;
    try {
      const launch = input('codex', 'orphan-terminal');
      launch.config.env.FIXTURE_PID_FILE = join(dir, 'child.pid');
      const handle = await createAdapters()
        .get('codex')!
        .launch(launch, () => {});
      pid = handle.pid;
      const result = await handle.result;
      expect(result.status).toBe('failed');
      expect(result.executionDisposition).toBe('unknown');
      expect(result.processGroupExited).toBe(true);
    } finally {
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          /* This fixture group already exited. */
        }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('rejects executable control overrides before starting a model', async () => {
    const launch = input('codex');
    launch.config.args.push('--dangerously-bypass-approvals-and-sandbox');
    await expect(
      createAdapters()
        .get('codex')!
        .launch(launch, () => {})
    ).rejects.toThrow(/INVALID_CONFIG/);
  });
  it('does not start an already cancelled input', async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await run('codex', 'normal', { signal: controller.signal })).outcome).toMatchObject({
      status: 'cancelled',
      executionDisposition: 'not_started'
    });
  });
  it('contains observer failure instead of letting it crash the runtime process', () => {
    const decoder = new EventDecoder('codex', undefined, [], () => {
      throw new Error('subscriber failed');
    });
    expect(() =>
      decoder.parse(
        JSON.stringify({
          type: 'thread.started',
          thread_id: '12345678-1234-4234-9234-123456789abc'
        })
      )
    ).not.toThrow();
    expect(decoder.failed).toBe(true);
  });
  it('cancels a running child on AbortSignal', async () => {
    const controller = new AbortController();
    const handle = await createAdapters()
      .get('zcode')!
      .launch(input('zcode', 'hang', { signal: controller.signal }), () => {});
    controller.abort();
    expect(await handle.result).toMatchObject({
      status: 'cancelled',
      executionDisposition: 'unknown'
    });
  });
  it('reports failed process spawn as not_started without raw command/environment diagnostics', async () => {
    const launch = input('zcode');
    launch.config.command = '/tmp/nonexistent-bridge-engine';
    const handle = await createAdapters()
      .get('zcode')!
      .launch(launch, () => {});
    expect(await handle.result).toMatchObject({
      status: 'failed',
      executionDisposition: 'not_started'
    });
  });
  it('does not silently accept pluginDirs on an unsupported host', async () => {
    const launch = input('zcode');
    launch.config.pluginDirs = ['/tmp/plugin'];
    await expect(
      createAdapters()
        .get('zcode')!
        .launch(launch, () => {})
    ).rejects.toThrow(/UNSUPPORTED_CAPABILITY/);
  });
  for (const engine of engines) {
    it(`${engine}: removes inherited and configured Bridge controls while retaining provider auth`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'bridge-env-'));
      const old = process.env.AGENT_BRIDGE_TEST_CONTROL;
      process.env.AGENT_BRIDGE_TEST_CONTROL = 'inherited-bridge-control';
      try {
        const launch = input(engine, 'env-check');
        Object.assign(launch.config.env, {
          AGENT_BRIDGE_TOKEN: 'configured-control-token',
          AGENT_BRIDGE_CONFIG: '/tmp/control-config',
          AGENT_BRIDGE_CALLER: 'controller',
          ANTHROPIC_API_KEY: 'native-auth-fixture',
          FIXTURE_ARGV_FILE: join(dir, 'argv.json')
        });
        const adapter = createAdapters().get(engine)!;
        expect((await adapter.probe(launch.config)).available).toBe(true);
        expect((await (await adapter.launch(launch, () => {})).result).status).toBe('completed');
        const environment = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as {
          bridgeKeys: string[];
          nativeAuthPreserved: boolean;
        };
        expect(environment.bridgeKeys).toEqual([]);
        expect(environment.nativeAuthPreserved).toBe(true);
      } finally {
        if (old === undefined) delete process.env.AGENT_BRIDGE_TEST_CONTROL;
        else process.env.AGENT_BRIDGE_TEST_CONTROL = old;
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
  for (const engine of ['claude-code', 'codex'] as const) {
    for (const resume of [false, true]) {
      it(`${engine}: treats leading option text as a literal positional prompt (${resume ? 'resume' : 'new'})`, async () => {
        const dir = await mkdtemp(join(tmpdir(), 'bridge-leading-prompt-'));
        try {
          const launch = input(engine, 'normal', {
            prompt: '--model attacker --dangerously-bypass-approvals-and-sandbox',
            ...(resume ? { sessionId: '12345678-1234-4234-9234-123456789abc' } : {})
          });
          launch.config.env.FIXTURE_ARGV_FILE = join(dir, 'argv.json');
          expect(
            (
              await (
                await createAdapters()
                  .get(engine)!
                  .launch(launch, () => {})
              ).result
            ).status
          ).toBe('completed');
          const actual = JSON.parse(await readFile(join(dir, 'argv.json'), 'utf8')) as {
            args: string[];
            positionalPrompt: string[];
          };
          expect(actual.args.slice(-2)).toEqual(['--', launch.prompt]);
          expect(actual.positionalPrompt).toEqual([launch.prompt]);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      });
    }
  }
  it('uses an explicit inline ZCode prompt value for leading dash text', () => {
    const prompt = '--model attacker --mode=yolo';
    const args = nativeArgs('zcode', input('zcode', 'normal', { prompt }));
    expect(args[0]).toBe(`--prompt=${prompt}`);
    const parsed = parseArgs({ args: args.slice(0, 1), options: { prompt: { type: 'string' } } });
    expect(parsed.values.prompt).toBe(prompt);
  });
});
