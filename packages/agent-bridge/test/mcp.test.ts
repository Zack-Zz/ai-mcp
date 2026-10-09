import { afterEach, describe, expect, it } from 'vitest';
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { request as httpRequest } from 'node:http';
import { serveBridgeHttp } from '../src/entrypoints/http.js';
import type { BridgeMcpPort } from '../src/entrypoints/mcp.js';
import { createBridgeMcpServer } from '../src/entrypoints/mcp.js';
import { serveBridgeStdio } from '../src/entrypoints/mcp.js';
import { BridgeError } from '../src/contracts/errors.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const modernClient = (name: string) =>
  new Client({ name, version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
const fixture = fileURLToPath(new URL('./fixtures/mcp-stdio.mjs', import.meta.url));
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const token = 'a'.repeat(64);
const expectedNames = [
  'agent_bridge_engines',
  'agent_bridge_preflight',
  'agent_bridge_start',
  'agent_bridge_get',
  'agent_bridge_list',
  'agent_bridge_events',
  'agent_bridge_continue',
  'agent_bridge_cancel',
  'agent_bridge_artifacts',
  'agent_bridge_artifact_read'
];
const spec = {
  taskSpecVersion: '1',
  objective: 'fixture task',
  acceptanceCriteria: ['fixture protocol passes'],
  constraints: [],
  writeScope: ['src/**'],
  contextRefs: [],
  scopeReference: 'fixture current user request',
  verificationIds: []
};
async function rawPost(url: string, headers: Record<string, string>, body = '{}') {
  return new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(url, { method: 'POST', headers }, (response) => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function stdio(name: string, ledger: string) {
  const client = modernClient(name);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', fixture],
    cwd: packageRoot,
    env: { MCP_TEST_LEDGER: ledger },
    stderr: 'pipe'
  });
  await client.connect(transport);
  cleanup.push(() => client.close());
  return client;
}

describe('official SDK v2 Bridge serving factories', () => {
  it('serves the ten scoped Bridge tools over real modern stdio client', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-mcp-test-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const client = await stdio('stdio-one', join(root, 'ledger.json'));
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expectedNames);
  });
  it('serves two real modern HTTP clients independently', async () => {
    const port: BridgeMcpPort = {
      async dispatch(operation) {
        return { operation, value: 'fixture' };
      }
    };
    const service = await serveBridgeHttp(port, { credential: token });
    cleanup.push(() => service.close());
    for (const name of ['http-one', 'http-two']) {
      const client = modernClient(name);
      cleanup.push(() => client.close());
      await client.connect(
        new StreamableHTTPClientTransport(new URL(service.url), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } }
        })
      );
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(expectedNames);
    }
  });
  it('refuses HTTP access without its separate local credential', async () => {
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          return {};
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    expect(
      (
        await fetch(service.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(401);
  });
  it('refuses a nonprivate HTTP credential file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-mcp-credential-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const credentialFile = join(root, 'credential.json');
    await writeFile(credentialFile, JSON.stringify({ token }), { mode: 0o644 });
    const opening = serveBridgeHttp(
      {
        async dispatch() {
          return {};
        }
      },
      { credentialFile }
    ).then((value) => {
      cleanup.push(() => value.close());
      return value;
    });
    await expect(opening).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
  });
  it('does not cancel or stop the external runtime when a stdio client closes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-mcp-persistence-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const ledger = join(root, 'ledger.json');
    const first = await stdio('first', ledger);
    await first.callTool({
      name: 'agent_bridge_start',
      arguments: { engine: 'codex', projectId: 'fixture', requestId: 'request1', taskSpec: spec }
    });
    await first.close();
    const second = await stdio('second', ledger);
    const response = await second.callTool({
      name: 'agent_bridge_get',
      arguments: { taskId: 'task_11111111-1111-1111-1111-111111111111' }
    });
    expect(response.structuredContent).toMatchObject({
      data: { state: 'running', sessionId: 'fixture-session' }
    });
    const calls = (await readFile(ledger + '.calls', 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { operation: string });
    expect(calls.map((call) => call.operation)).toEqual(['task.start', 'task.get']);
  });
  it('preserves operation DTO and request ID without nested legacy tool results', async () => {
    const seen: { operation: string; args: unknown }[] = [];
    const service = await serveBridgeHttp(
      {
        async dispatch(operation, args) {
          seen.push({ operation, args });
          return { taskId: 'task_11111111-1111-1111-1111-111111111111', state: 'queued' };
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const client = modernClient('dto');
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const response = await client.callTool({
      name: 'agent_bridge_start',
      arguments: { engine: 'zcode', projectId: 'fixture', requestId: 'stable-1', taskSpec: spec }
    });
    expect(response.structuredContent).toEqual({
      apiVersion: 'agent-bridge/v1',
      operation: 'task.start',
      requestId: 'stable-1',
      data: { taskId: 'task_11111111-1111-1111-1111-111111111111', state: 'queued' }
    });
    expect(seen[0]).toMatchObject({
      operation: 'task.start',
      args: { engine: 'zcode', projectId: 'fixture', requestId: 'stable-1' }
    });
    expect(response.isError).not.toBe(true);
  });
  it('returns classified Bridge errors and masks unexpected exception details', async () => {
    const service = await serveBridgeHttp(
      {
        async dispatch(operation) {
          if (operation === 'task.get')
            throw new BridgeError('POLICY_DENIED', 'different owner', 'not_started');
          throw new Error('sensitive exception detail');
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const client = modernClient('errors');
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const denied = await client.callTool({
      name: 'agent_bridge_get',
      arguments: { taskId: 'task_11111111-1111-1111-1111-111111111111' }
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      error: { code: 'POLICY_DENIED', executionDisposition: 'not_started' }
    });
    const unknown = await client.callTool({ name: 'agent_bridge_engines', arguments: {} });
    expect(unknown.isError).toBe(true);
    expect(unknown.structuredContent).toMatchObject({
      error: { code: 'INTERNAL', executionDisposition: 'unknown' }
    });
    expect(JSON.stringify(unknown)).not.toContain('sensitive exception detail');
  });
  it('uses complete input/output schemas and rejects caller role injection before dispatch', async () => {
    let calls = 0;
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          calls++;
          return {};
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const client = modernClient('schemas');
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const start = (await client.listTools()).tools.find(
      (tool) => tool.name === 'agent_bridge_start'
    );
    expect(start?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: expect.arrayContaining(['engine', 'projectId', 'requestId', 'taskSpec'])
    });
    expect(start?.outputSchema).toMatchObject({
      type: 'object',
      properties: { apiVersion: {}, operation: {}, data: {}, error: {} }
    });
    const rejection = await client
      .callTool({
        name: 'agent_bridge_start',
        arguments: {
          engine: 'codex',
          projectId: 'fixture',
          requestId: 'x',
          taskSpec: spec,
          callerRef: 'other',
          role: 'controller'
        }
      })
      .catch((error) => error);
    expect(rejection.isError === true || rejection instanceof Error).toBe(true);
    expect(calls).toBe(0);
  });
  it('guards Host and Origin before reaching the bound caller port', async () => {
    let calls = 0;
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          calls++;
          return {};
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    expect(await rawPost(service.url, { ...headers, Host: 'evil.invalid' })).toBe(403);
    expect(await rawPost(service.url, { ...headers, Origin: 'https://evil.invalid' })).toBe(403);
    expect(calls).toBe(0);
  });
  it('explicitly rejects legacy initialization on the HTTP endpoint', async () => {
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          return {};
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const response = await fetch(service.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy', version: '1' }
        }
      })
    });
    const body = (await response.json()) as { error?: { code: number } };
    expect(body.error?.code).toBe(-32022);
  });
  it('coexists with another module registered on the same v2 server instance', async () => {
    const server = createBridgeMcpServer({
      async dispatch(operation) {
        return { operation };
      }
    });
    server.registerTool('fixture_other_module', { inputSchema: z.strictObject({}) }, async () => ({
      content: [{ type: 'text', text: 'other module' }]
    }));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => server, { transport: serverTransport, legacy: 'reject' });
    const client = modernClient('composed');
    cleanup.push(() => client.close());
    cleanup.push(() => handle.close());
    await client.connect(clientTransport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      ...expectedNames,
      'fixture_other_module'
    ]);
    expect(
      (await client.callTool({ name: 'fixture_other_module', arguments: {} })).content
    ).toMatchObject([{ text: 'other module' }]);
  });
  it('maps all ten tools to the same canonical Bridge operation and bounded arguments', async () => {
    const seen: { operation: string; args: Record<string, unknown> }[] = [];
    const service = await serveBridgeHttp(
      {
        async dispatch(operation, args) {
          seen.push({ operation, args: args as Record<string, unknown> });
          return { operation };
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const client = modernClient('all-operations');
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const taskId = 'task_11111111-1111-1111-1111-111111111111';
    const cases: [string, string, Record<string, unknown>][] = [
      ['agent_bridge_engines', 'engine.list', {}],
      [
        'agent_bridge_preflight',
        'preflight',
        { engine: 'zcode', projectId: 'fixture', workspacePolicy: 'existing', taskSpec: spec }
      ],
      [
        'agent_bridge_start',
        'task.start',
        {
          engine: 'codex',
          projectId: 'fixture',
          requestId: 'start-1',
          sameEngineIntent: 'independent-session',
          taskSpec: spec
        }
      ],
      ['agent_bridge_get', 'task.get', { taskId }],
      ['agent_bridge_list', 'task.list', { limit: 10 }],
      ['agent_bridge_events', 'task.watch', { taskId, cursor: 'event_4', waitMs: 0, limit: 10 }],
      [
        'agent_bridge_continue',
        'task.continue',
        { taskId, requestId: 'continue-1', message: 'same original scope' }
      ],
      ['agent_bridge_cancel', 'task.cancel', { taskId, requestId: 'cancel-1' }],
      ['agent_bridge_artifacts', 'artifact.list', { taskId }],
      [
        'agent_bridge_artifact_read',
        'artifact.read',
        { taskId, artifactId: 'registered-id', offset: 7, limit: 10 }
      ]
    ];
    for (const [name, operation, args] of cases) {
      const response = await client.callTool({ name, arguments: args });
      expect(response.structuredContent).toMatchObject({
        apiVersion: 'agent-bridge/v1',
        operation,
        data: { operation }
      });
      expect(seen.at(-1)).toMatchObject({ operation, args });
    }
    expect(seen.map((call) => call.operation)).toEqual(cases.map(([, operation]) => operation));
  });
  it('does not describe a native task execution tool as a closed-world read operation', async () => {
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          return {};
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const client = modernClient('annotations');
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const start = (await client.listTools()).tools.find(
      (tool) => tool.name === 'agent_bridge_start'
    );
    expect(start?.annotations).toMatchObject({ readOnlyHint: false, openWorldHint: true });
  });
  it('accepts a private credential file and rejects symlinks, malformed and missing credentials', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-mcp-private-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const credentialFile = join(root, 'credential.json');
    await writeFile(credentialFile, JSON.stringify({ token }), { mode: 0o600 });
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          return {};
        }
      },
      { credentialFile }
    );
    cleanup.push(() => service.close());
    expect(service.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await expect(
      serveBridgeHttp({
        async dispatch() {
          return {};
        }
      })
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(
      serveBridgeHttp(
        {
          async dispatch() {
            return {};
          }
        },
        { credential: 'weak' }
      )
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    const link = join(root, 'link.json');
    await symlink(credentialFile, link);
    await expect(
      serveBridgeHttp(
        {
          async dispatch() {
            return {};
          }
        },
        { credentialFile: link }
      )
    ).rejects.toMatchObject({ code: 'STATE_UNSAFE' });
    const malformed = join(root, 'malformed.json');
    await writeFile(malformed, '{broken', { mode: 0o600 });
    await expect(
      serveBridgeHttp(
        {
          async dispatch() {
            return {};
          }
        },
        { credentialFile: malformed }
      )
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });
  it('rejects modern calls with wrong credentials and unrelated routes without dispatching', async () => {
    let calls = 0;
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          calls++;
          return {};
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    expect(await rawPost(service.url, { Authorization: `Bearer ${'b'.repeat(64)}` })).toBe(401);
    expect(
      await rawPost(service.url.replace('/mcp', '/other'), { Authorization: `Bearer ${token}` })
    ).toBe(404);
    expect(calls).toBe(0);
  });
  it('explicitly rejects an official client using legacy stdio initialization', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-mcp-legacy-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const client = new Client({ name: 'legacy-stdio', version: '1' });
    cleanup.push(() => client.close());
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', fixture],
      cwd: packageRoot,
      env: { MCP_TEST_LEDGER: join(root, 'ledger.json') },
      stderr: 'pipe'
    });
    await expect(client.connect(transport)).rejects.toMatchObject({ code: -32022 });
  });
  it('makes HTTP facade closure idempotent without closing its external task port', async () => {
    let closed = 0;
    const port = {
      async dispatch() {
        return {};
      },
      async close() {
        closed++;
      }
    };
    const service = await serveBridgeHttp(port, { credential: token });
    cleanup.push(() => service.close());
    await service.close();
    await service.close();
    expect(closed).toBe(0);
  });
  it('serves the stdio wrapper factory with a supplied official transport', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveBridgeStdio(
      {
        async dispatch() {
          return { engines: [] };
        }
      },
      { transport: serverTransport }
    );
    cleanup.push(() => handle.close());
    const client = modernClient('stdio-wrapper');
    cleanup.push(() => client.close());
    await client.connect(clientTransport);
    expect(
      (await client.callTool({ name: 'agent_bridge_engines', arguments: {} })).structuredContent
    ).toMatchObject({ operation: 'engine.list', data: { engines: [] } });
  });
  it('keeps a failed task query successful and rejects an empty backend reply', async () => {
    const service = await serveBridgeHttp(
      {
        async dispatch(operation) {
          if (operation === 'task.get') return { state: 'failed' };
          return undefined;
        }
      },
      { credential: token }
    );
    cleanup.push(() => service.close());
    const client = modernClient('query-semantics');
    cleanup.push(() => client.close());
    await client.connect(
      new StreamableHTTPClientTransport(new URL(service.url), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } }
      })
    );
    const result = await client.callTool({
      name: 'agent_bridge_get',
      arguments: { taskId: 'task_11111111-1111-1111-1111-111111111111' }
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ data: { state: 'failed' } });
    const malformed = await client.callTool({ name: 'agent_bridge_engines', arguments: {} });
    expect(malformed.isError).toBe(true);
    expect(malformed.structuredContent).toMatchObject({ error: { code: 'PROTOCOL_ERROR' } });
  });
  it('rejects an invalid explicit HTTP body limit rather than ignoring it', async () => {
    const opening = serveBridgeHttp(
      {
        async dispatch() {
          return {};
        }
      },
      { credential: token, maxRequestBodySize: 0 }
    ).then((value) => {
      cleanup.push(() => value.close());
      return value;
    });
    await expect(opening).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
  it('enforces the same body bound before protocol parsing and port dispatch', async () => {
    let calls = 0;
    const service = await serveBridgeHttp(
      {
        async dispatch() {
          calls++;
          return {};
        }
      },
      { credential: token, maxRequestBodySize: 256 }
    );
    cleanup.push(() => service.close());
    expect(
      await rawPost(
        service.url,
        { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ' '.repeat(1024) + '{}'
      )
    ).toBe(413);
    expect(calls).toBe(0);
  });
});
