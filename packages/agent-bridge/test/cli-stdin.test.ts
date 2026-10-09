import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCommand, runCli, type CliOptions } from '../src/entrypoints/cli.js';

const spec = {
  taskSpecVersion: '1',
  objective: '修复值并保留换行',
  acceptanceCriteria: ['Registered check passes'],
  writeScope: ['src/value.txt'],
  scopeReference: 'user:stdin'
};
async function* chunks(value: Uint8Array) {
  yield value.subarray(0, 41);
  yield value.subarray(41, 43);
  yield value.subarray(43);
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-stdin-'));
  const config = join(root, 'config.json');
  await writeFile(
    config,
    JSON.stringify({
      schemaVersion: 1,
      stateRoot: join(root, 'private-state'),
      projects: [{ id: 'sample', repoRoot: root }],
      engines: { codex: { command: 'codex' } },
      clients: [{ id: 'terminal', role: 'controller' }]
    }),
    { mode: 0o600 }
  );
  return { root, config };
}
describe('CLI stdin handoff without source-directory temporary files', () => {
  it('recognizes a lone hyphen only as an input-file option value', () => {
    expect(
      parseCommand(['preflight', '--engine', 'codex', '--project', 'sample', '--spec-file', '-'])
        .values['spec-file']
    ).toBe('-');
    expect(
      parseCommand(['task', 'continue', 'task_123', '--message-file=-']).values['message-file']
    ).toBe('-');
    expect(() => parseCommand(['preflight', '--engine', '-'])).toThrow(/INVALID_ARGUMENT/);
  });
  it.each(['preflight', 'task.start'])(
    '%s parses split UTF-8 JSON from stdin with the same TaskSpec defaults',
    async (operation) => {
      const files = await fixture();
      const dispatch = vi.fn(async () => ({ accepted: true }));
      try {
        const argv = [
          ...operation.split('.'),
          '--engine',
          'codex',
          '--project',
          'sample',
          '--spec-file',
          '-',
          '--config',
          files.config,
          '--json',
          ...(operation === 'task.start' ? ['--request-id', 'stdin-start'] : [])
        ];
        const options: CliOptions & { stdin: AsyncIterable<Uint8Array> } = {
          stdin: chunks(Buffer.from(JSON.stringify(spec))),
          stdout: () => {},
          stderr: () => {},
          connect: async () => ({ dispatch })
        };
        expect(await runCli(argv, options)).toBe(0);
        expect(dispatch).toHaveBeenCalledWith(
          operation,
          expect.objectContaining({
            taskSpec: expect.objectContaining({
              ...spec,
              constraints: [],
              contextRefs: [],
              verificationIds: []
            })
          })
        );
        expect((await readdir(files.root)).filter((name) => name.endsWith('.json'))).toEqual([
          'config.json'
        ]);
      } finally {
        await rm(files.root, { recursive: true, force: true });
      }
    }
  );
  it('passes continuation text as data including leading flags and shell syntax', async () => {
    const files = await fixture();
    const dispatch = vi.fn(async () => ({ accepted: true }));
    const message = '--model attacker; $(do-not-execute)\n原范围内继续';
    try {
      expect(
        await runCli(
          [
            'task',
            'continue',
            'task_123',
            '--message-file=-',
            '--config',
            files.config,
            '--request-id',
            'stdin-continue',
            '--json'
          ],
          {
            stdin: chunks(Buffer.from(message)),
            stdout: () => {},
            stderr: () => {},
            connect: async () => ({ dispatch })
          } as CliOptions & { stdin: AsyncIterable<Uint8Array> }
        )
      ).toBe(0);
      expect(dispatch).toHaveBeenCalledWith('task.continue', {
        taskId: 'task_123',
        message,
        requestId: 'stdin-continue'
      });
    } finally {
      await rm(files.root, { recursive: true, force: true });
    }
  });
  it.each([
    Buffer.from('not-json'),
    Buffer.from('{"taskSpecVersion":"1"}'),
    Buffer.alloc(4 * 1024 * 1024 + 1, 32),
    Buffer.from([0xff])
  ])('rejects invalid or oversized stdin before connecting', async (input) => {
    const connect = vi.fn();
    let reply = '';
    expect(
      await runCli(
        [
          'preflight',
          '--engine',
          'codex',
          '--project',
          'sample',
          '--spec-file=-',
          '--config',
          '/not-needed/config.json',
          '--json'
        ],
        {
          stdin: chunks(input),
          connect,
          stdout: (value) => {
            reply += value;
          },
          stderr: () => {}
        } as CliOptions & { stdin: AsyncIterable<Uint8Array> }
      )
    ).toBe(2);
    expect(JSON.parse(reply)).toMatchObject({
      error: { code: 'INVALID_ARGUMENT', executionDisposition: 'not_started' }
    });
    expect(connect).not.toHaveBeenCalled();
  });
});
