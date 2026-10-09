import { describe, expect, it } from 'vitest';
import { parseCommand, runCli } from '../src/entrypoints/cli.js';
import { mkdtemp, writeFile, readdir, readFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeError } from '../src/contracts/errors.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const sourceCli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const loader = createRequire(import.meta.url).resolve('tsx/esm');
async function invoke(
  args: string[]
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, ['--import', loader, sourceCli, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (data) => {
    stdout += String(data);
  });
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stdout, stderr }));
  });
}
const spec = {
  taskSpecVersion: '1',
  objective: 'Scoped work',
  acceptanceCriteria: ['Done'],
  constraints: [],
  writeScope: ['src/**'],
  contextRefs: [],
  scopeReference: 'user:request',
  verificationIds: []
};
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-cli-'));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      stateRoot: join(root, 'state'),
      projects: [{ id: 'sample', repoRoot: root }],
      engines: { codex: { command: 'codex' } },
      clients: [
        { id: 'terminal', role: 'controller' },
        { id: 'terminal:other', role: 'controller' },
        { id: 'worker', role: 'worker' }
      ]
    }),
    { mode: 0o600 }
  );
  const specPath = join(root, 'spec.json');
  await writeFile(specPath, JSON.stringify(spec));
  const messagePath = join(root, 'message.txt');
  await writeFile(messagePath, 'Continue within scope');
  return { root, configPath, specPath, messagePath };
}
describe('Explicit bounded CLI commands', () => {
  it('allows the same requestId in distinct configured caller namespaces', async () => {
    const files = await setup();
    let calls = 0;
    try {
      for (const caller of ['terminal', 'terminal:other']) {
        expect(
          await runCli(
            [
              'task',
              'start',
              '--config',
              files.configPath,
              '--caller-ref',
              caller,
              '--engine',
              'codex',
              '--project',
              'sample',
              '--spec-file',
              files.specPath,
              '--request-id',
              'shared-local-id',
              '--json'
            ],
            {
              stdout: () => {},
              stderr: () => {},
              connect: async () => ({
                dispatch: async () => {
                  calls++;
                  return { accepted: true };
                }
              })
            }
          )
        ).toBe(0);
      }
      expect(calls).toBe(2);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
  it('maps explicit start flags without allowing a shell command', () => {
    expect(
      parseCommand([
        'task',
        'start',
        '--engine',
        'codex',
        '--project',
        'sample',
        '--spec-file',
        '/tmp/spec.json',
        '--independent-session',
        '--request-id',
        'req-1',
        '--json'
      ])
    ).toMatchObject({
      operation: 'task.start',
      json: true,
      values: {
        engine: 'codex',
        project: 'sample',
        'spec-file': '/tmp/spec.json',
        'independent-session': true,
        'request-id': 'req-1'
      }
    });
  });
  it('shows command help without reading config or starting a runtime', async () => {
    let output = '';
    expect(
      await runCli(['task', 'start', '--help'], {
        stdout: (text) => {
          output += text;
        },
        stderr: () => {}
      })
    ).toBe(0);
    expect(output).toContain('--spec-file');
    expect(output).toContain('--engine');
  });
  it('exposes independent stdio and authenticated HTTP MCP entrypoints without creating an engine task', async () => {
    expect(parseCommand(['mcp', 'stdio', '--config', '/tmp/private-config.json'])).toMatchObject({
      operation: 'mcp.stdio'
    });
    expect(
      parseCommand(['mcp', 'http', '--credential-file', '/tmp/private-http.json', '--port', '7001'])
    ).toMatchObject({
      operation: 'mcp.http',
      values: { port: '7001', 'credential-file': '/tmp/private-http.json' }
    });
    for (const words of [
      ['mcp', 'stdio'],
      ['mcp', 'http']
    ]) {
      let output = '';
      expect(
        await runCli([...words, '--help'], {
          stdout: (text) => {
            output += text;
          },
          stderr: () => {}
        })
      ).toBe(0);
      expect(output).toContain('Example: agent-bridge');
    }
  });
  it('rejects unknown commands, duplicated/foreign flags and shell injection', () => {
    for (const args of [
      ['run-shell', 'rm'],
      ['task', 'get', '--engine', 'codex'],
      ['task', 'start', '--engine', 'codex', '--engine', 'zcode'],
      ['engine', 'list', '--approved'],
      ['task', 'cancel', '--request-id']
    ])
      expect(() => parseCommand(args)).toThrow(/INVALID_ARGUMENT/);
  });
  it('provides help for every documented verb with a copyable example', async () => {
    for (const words of [
      ['engine', 'list'],
      ['preflight'],
      ['task', 'start'],
      ['task', 'get'],
      ['task', 'list'],
      ['task', 'watch'],
      ['task', 'continue'],
      ['task', 'cancel'],
      ['artifact', 'list'],
      ['artifact', 'read'],
      ['runtime', 'serve'],
      ['runtime', 'stop']
    ]) {
      let output = '';
      expect(
        await runCli([...words, '--help'], {
          stdout: (text) => {
            output += text;
          },
          stderr: () => {}
        })
      ).toBe(0);
      expect(output).toContain('Example: agent-bridge');
    }
  });
  it('maps full command args to the stable app port through an injected connector', async () => {
    const files = await setup();
    const task = 'task_12345678-1234-4234-9234-123456789abc';
    const cases: Array<[string[], string, Record<string, unknown>]> = [
      [['engine', 'list'], 'engine.list', {}],
      [
        ['preflight', '--engine', 'codex', '--project', 'sample'],
        'preflight',
        { engine: 'codex', projectId: 'sample' }
      ],
      [
        [
          'task',
          'start',
          '--engine',
          'codex',
          '--project',
          'sample',
          '--spec-file',
          files.specPath,
          '--request-id',
          'req-start',
          '--workspace-policy',
          'existing',
          '--independent-session'
        ],
        'task.start',
        {
          engine: 'codex',
          projectId: 'sample',
          taskSpec: spec,
          requestId: 'req-start',
          workspacePolicy: 'existing',
          sameEngineIntent: 'independent-session'
        }
      ],
      [['task', 'get', task], 'task.get', { taskId: task }],
      [['task', 'list', '--limit', '10'], 'task.list', { limit: 10 }],
      [
        ['task', 'watch', task, '--cursor', 'event_7', '--wait-ms', '20'],
        'task.watch',
        { taskId: task, cursor: 'event_7', waitMs: 20 }
      ],
      [
        [
          'task',
          'continue',
          task,
          '--message-file',
          files.messagePath,
          '--request-id',
          'req-continue'
        ],
        'task.continue',
        { taskId: task, requestId: 'req-continue', message: 'Continue within scope' }
      ],
      [
        ['task', 'cancel', task, '--request-id', 'req-cancel'],
        'task.cancel',
        { taskId: task, requestId: 'req-cancel' }
      ],
      [['artifact', 'list', '--task', task], 'artifact.list', { taskId: task }],
      [
        ['artifact', 'read', 'artifact_123', '--task', task, '--offset', '2', '--limit', '10'],
        'artifact.read',
        { taskId: task, artifactId: 'artifact_123', offset: 2, limit: 10 }
      ],
      [['runtime', 'stop', '--request-id', 'req-stop'], 'runtime.stop', { requestId: 'req-stop' }]
    ];
    try {
      for (const [words, operation, expected] of cases) {
        let output = '';
        let call: unknown;
        const code = await runCli(
          [...words, '--config', files.configPath, '--caller-ref', 'terminal', '--json'],
          {
            stdout: (text) => {
              output += text;
            },
            stderr: () => {},
            connect: async (_config, options) => {
              expect(options.callerRef).toBe('terminal');
              return {
                dispatch: async (op, args) => {
                  call = { op, args };
                  return { acknowledged: true };
                }
              };
            }
          }
        );
        expect(code).toBe(0);
        expect(call).toEqual({ op: operation, args: expected });
        expect(JSON.parse(output)).toMatchObject({
          apiVersion: 'agent-bridge/v1',
          operation,
          data: { acknowledged: true }
        });
      }
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
  it('saves automatic requestId before dispatch, reports unknown outcome and never replays', async () => {
    const files = await setup();
    let calls = 0;
    let output = '';
    let diagnostic = '';
    try {
      const code = await runCli(
        [
          'task',
          'start',
          '--engine',
          'codex',
          '--project',
          'sample',
          '--spec-file',
          files.specPath,
          '--config',
          files.configPath,
          '--json'
        ],
        {
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            diagnostic += text;
          },
          connect: async () => ({
            dispatch: async (_op, raw) => {
              calls++;
              const args = raw as { requestId: string };
              const path = diagnostic.match(/Receipt: ([^\n]+)/)?.[1];
              expect(path).toBeTruthy();
              expect((await lstat(path!)).mode & 0o777).toBe(0o600);
              expect(JSON.parse(await readFile(path!, 'utf8'))).toMatchObject({
                callerRef: 'terminal',
                operation: 'task.start',
                requestId: args.requestId
              });
              throw new BridgeError('CONNECTION_TIMEOUT', 'Recover original request', 'unknown');
            }
          })
        }
      );
      expect(code).toBe(1);
      expect(calls).toBe(1);
      const reply = JSON.parse(output) as {
        requestId: string;
        error: { executionDisposition: string };
      };
      expect(reply.requestId).toMatch(/^req_/);
      expect(reply.error.executionDisposition).toBe('unknown');
      expect(diagnostic).toContain(reply.requestId);
      const filesSaved = await readdir(join(files.root, 'state', 'operations'), {
        recursive: true
      });
      const saved = filesSaved.filter((path) => path.endsWith('.json'));
      expect(saved).toHaveLength(1);
      expect(saved[0]).toContain(`${reply.requestId}.json`);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
  it('rejects missing/invalid parameters before connecting or bootstrapping', async () => {
    const files = await setup();
    let connected = 0;
    try {
      for (const words of [
        ['task', 'start'],
        ['task', 'continue', 'task_x'],
        ['task', 'watch', 'task_x', '--wait-ms', '999999'],
        ['artifact', 'read', 'artifact_x', '--task', 'task_x', '--limit', '0']
      ]) {
        expect(
          await runCli([...words, '--config', files.configPath], {
            stdout: () => {},
            stderr: () => {},
            connect: async () => {
              connected++;
              throw new Error('must not connect');
            }
          })
        ).toBe(2);
      }
      expect(connected).toBe(0);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
  it('starts an independent source runtime once, reconnects and stops it with the native read-only app operation', async () => {
    const files = await setup();
    const raw = JSON.parse(await readFile(files.configPath, 'utf8')) as { engines: unknown };
    raw.engines = {
      codex: {
        codexTransport: 'exec',
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/cli-engine.mjs', import.meta.url))]
      }
    };
    await writeFile(files.configPath, JSON.stringify(raw), { mode: 0o600 });
    const flags = ['--config', files.configPath, '--json'];
    try {
      const first = await invoke(['engine', 'list', ...flags]);
      expect(first.code, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toMatchObject({
        operation: 'engine.list',
        data: {
          engines: [
            { engine: 'claude-code', available: false },
            { engine: 'zcode', available: false },
            { engine: 'codex', available: true }
          ]
        }
      });
      const binding = JSON.parse(
        await readFile(join(files.root, 'state', 'runtime.lock.json'), 'utf8')
      ) as { pid: number };
      expect(binding.pid).not.toBe(process.pid);
      const second = await invoke(['task', 'list', ...flags]);
      expect(second.code, second.stderr).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({ data: { tasks: [] } });
      expect(
        JSON.parse(await readFile(join(files.root, 'state', 'runtime.lock.json'), 'utf8'))
      ).toMatchObject({ pid: binding.pid });
      const stopped = await invoke([
        'runtime',
        'stop',
        '--request-id',
        'stop-child-runtime',
        ...flags
      ]);
      expect(stopped.code, stopped.stderr).toBe(0);
      for (let count = 0; count < 100; count++) {
        try {
          await lstat(join(files.root, 'state', 'runtime.lock.json'));
          await new Promise((resolve) => setTimeout(resolve, 10));
        } catch {
          break;
        }
      }
      await expect(lstat(join(files.root, 'state', 'runtime.lock.json'))).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      try {
        await lstat(join(files.root, 'state', 'runtime.lock.json'));
        await invoke(['runtime', 'stop', '--request-id', 'cleanup-child-runtime', ...flags]);
      } catch {
        /* No bootstrap when cleanup is unnecessary. */
      }
      await rm(files.root, { recursive: true, force: true });
    }
  }, 15000);
  it('does not bootstrap a new runtime merely to stop an absent runtime', async () => {
    const files = await setup();
    try {
      const result = await invoke([
        'runtime',
        'stop',
        '--config',
        files.configPath,
        '--request-id',
        'stop-absent',
        '--json'
      ]);
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        error: { code: 'RUNTIME_UNAVAILABLE', executionDisposition: 'not_started' }
      });
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  }, 10000);
  it('handles missing config, inline values, invalid specs and requestId conflicts before dispatch', async () => {
    const files = await setup();
    let connected = 0;
    try {
      expect(parseCommand(['engine', 'list', `--config=${files.configPath}`, '-h'])).toMatchObject({
        configPath: files.configPath,
        help: true
      });
      let help = '';
      expect(
        await runCli([], {
          stdout: (text) => {
            help += text;
          },
          stderr: () => {}
        })
      ).toBe(0);
      expect(help).toContain('Commands:');
      const cases = [
        ['preflight', '--engine', 'unknown', '--project', 'sample'],
        ['task', 'get'],
        ['task', 'list', '--limit', 'NaN'],
        ['engine', 'list', '--config', join(files.root, 'absent')],
        ['engine', 'list', '--caller-ref', 'undeclared']
      ];
      for (const words of cases) {
        const args = words.includes('--config') ? words : [...words, '--config', files.configPath];
        expect(
          await runCli(args, {
            stdout: () => {},
            stderr: () => {},
            connect: async () => {
              connected++;
              throw new Error();
            }
          })
        ).not.toBe(0);
      }
      await writeFile(files.specPath, JSON.stringify({ ...spec, approved: true }));
      expect(
        await runCli(
          [
            'task',
            'start',
            '--engine',
            'codex',
            '--project',
            'sample',
            '--spec-file',
            files.specPath,
            '--config',
            files.configPath
          ],
          { stdout: () => {}, stderr: () => {} }
        )
      ).toBe(2);
      expect(connected).toBe(0);
      await writeFile(files.specPath, JSON.stringify(spec));
      const command = [
        'task',
        'start',
        '--engine',
        'codex',
        '--project',
        'sample',
        '--spec-file',
        files.specPath,
        '--config',
        files.configPath,
        '--request-id',
        'fixed-id'
      ];
      const connect = async () => ({ dispatch: async () => ({ taskId: 'task_display' }) });
      let output = '';
      expect(
        await runCli(command, {
          stdout: (text) => {
            output += text;
          },
          stderr: () => {},
          connect
        })
      ).toBe(0);
      expect(output).toContain('task_display');
      expect(await runCli(command, { stdout: () => {}, stderr: () => {}, connect })).toBe(0);
      await writeFile(files.specPath, JSON.stringify({ ...spec, objective: 'Changed request' }));
      expect(await runCli(command, { stdout: () => {}, stderr: () => {}, connect })).toBe(2);
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
});
