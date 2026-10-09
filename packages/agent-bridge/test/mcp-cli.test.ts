import { describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const loader = createRequire(import.meta.url).resolve('tsx/esm');
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const modern = () =>
  new Client(
    { name: 'actual-bridge-cli-test', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } }
  );
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'bridge-mcp-cli-'));
  const configPath = join(root, 'config.json');
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: 1,
      stateRoot: join(root, 'state'),
      projects: [{ id: 'fixture', repoRoot: root }],
      engines: {
        codex: {
          codexTransport: 'exec',
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/cli-engine.mjs', import.meta.url))]
        }
      },
      clients: [{ id: 'terminal', role: 'controller' }]
    }),
    { mode: 0o600 }
  );
  return { root, configPath };
}
async function stop(configPath: string) {
  const child = spawn(
    process.execPath,
    [
      '--import',
      loader,
      cli,
      'runtime',
      'stop',
      '--request-id',
      'test-mcp-stop',
      '--config',
      configPath,
      '--json'
    ],
    { stdio: 'ignore' }
  );
  await new Promise((resolve) => child.once('exit', resolve));
}

describe('Actual MCP CLI entrypoints over the actual independent runtime', () => {
  it('serves stdio via a modern SDK client and keeps the daemon alive after its caller closes', async () => {
    const files = await setup();
    const client = modern();
    const reopened = modern();
    const transport = () =>
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', loader, cli, 'mcp', 'stdio', '--config', files.configPath],
        stderr: 'pipe'
      });
    try {
      await client.connect(transport());
      expect((await client.listTools()).tools).toHaveLength(10);
      const result = await client.callTool({ name: 'agent_bridge_engines', arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toMatchObject({
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
      await client.close();
      await reopened.connect(transport());
      expect(
        (await reopened.callTool({ name: 'agent_bridge_list', arguments: {} })).structuredContent
      ).toMatchObject({ data: { tasks: [] } });
      expect(
        JSON.parse(await readFile(join(files.root, 'state', 'runtime.lock.json'), 'utf8'))
      ).toMatchObject({ pid: binding.pid });
    } finally {
      await client.close().catch(() => undefined);
      await reopened.close().catch(() => undefined);
      await stop(files.configPath);
      await rm(files.root, { recursive: true, force: true });
    }
  }, 15000);
  it('serves authenticated HTTP and closes only the facade on SIGTERM', async () => {
    const files = await setup();
    const credentialFile = join(files.root, 'http-token.json');
    const token = 'b'.repeat(64);
    await writeFile(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
    const child = spawn(
      process.execPath,
      [
        '--import',
        loader,
        cli,
        'mcp',
        'http',
        '--config',
        files.configPath,
        '--credential-file',
        credentialFile,
        '--json'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const exited = new Promise((resolve) => child.once('exit', resolve));
    const client = modern();
    try {
      const reply = await new Promise<{ data: { url: string } }>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error('HTTP CLI startup timed out')), 7000);
        child.stdout.on('data', (data) => {
          output += String(data);
          if (output.includes('\n')) {
            clearTimeout(timer);
            try {
              resolve(JSON.parse(output));
            } catch (error) {
              reject(error);
            }
          }
        });
        child.once('exit', () => {
          clearTimeout(timer);
          if (!output) reject(new Error('HTTP CLI exited without a ready URL'));
        });
      });
      const url = new URL(reply.data.url);
      expect(url.hostname).toBe('127.0.0.1');
      expect((await fetch(url)).status).toBe(401);
      await client.connect(
        new StreamableHTTPClientTransport(url, {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        })
      );
      expect(
        (await client.callTool({ name: 'agent_bridge_list', arguments: {} })).structuredContent
      ).toMatchObject({ operation: 'task.list', data: { tasks: [] } });
      const binding = JSON.parse(
        await readFile(join(files.root, 'state', 'runtime.lock.json'), 'utf8')
      ) as { pid: number };
      await client.close();
      child.kill('SIGTERM');
      await exited;
      expect(
        JSON.parse(await readFile(join(files.root, 'state', 'runtime.lock.json'), 'utf8'))
      ).toMatchObject({ pid: binding.pid });
    } finally {
      await client.close().catch(() => undefined);
      child.kill('SIGTERM');
      await exited;
      await stop(files.configPath);
      await rm(files.root, { recursive: true, force: true });
    }
  }, 15000);
});
