import { expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpGatewayServer } from '../src/gateway-server.js';
import { JsonlAuditStore } from '../src/audit-jsonl.js';
import type { DownstreamConnector } from '../src/connectors/base.js';

it('cancels a non-cooperative downstream call on service shutdown without waiting forever', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const connector: DownstreamConnector = {
    listTools: async () => [
      {
        name: 'probe',
        description: '',
        descriptor: { name: 'probe', inputSchema: { type: 'object' } }
      }
    ],
    callTool: async () => {
      entered();
      await blocked;
      return {
        durationMs: 0,
        native: { content: [], structuredContent: { done: true }, isError: false },
        output: { ok: true, code: 'OK', message: '' }
      };
    },
    close: async () => undefined
  };
  const gateway = new McpGatewayServer(
    [{ id: 'b', transport: 'http', endpoint: 'http://unused' }],
    { connectorFactory: () => connector, shutdownGraceMs: 30 }
  );
  await gateway.initialize();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gateway.connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  const call = client.callTool({ name: 'b__probe', arguments: {} }).catch(() => undefined);
  await started;
  const closing = gateway.close();
  try {
    expect(
      await Promise.race([
        closing.then(() => 'closed'),
        new Promise<string>((r) => setTimeout(() => r('hung'), 300))
      ])
    ).toBe('closed');
  } finally {
    release();
    await closing;
    await call;
    await client.close();
  }
  expect(gateway.getInMemoryAuditEvents()).toMatchObject([
    { outcome: 'cancelled', executionDisposition: 'unknown' }
  ]);
});

it('retains connector risk and visibility for discovery, authorization and audit', async () => {
  let calls = 0;
  const connector: DownstreamConnector = {
    listTools: async () =>
      ['critical', 'hidden', 'visible'].map((name) => ({
        name,
        description: name,
        descriptor: {
          name,
          title: `${name} title`,
          icons: [{ src: 'https://example.com/icon.png' }],
          inputSchema: { type: 'object' }
        },
        metadata: {
          riskLevel: name === 'critical' ? 'critical' : 'low',
          visibility: name === 'hidden' ? 'hidden' : 'public'
        }
      })),
    callTool: async () => {
      calls++;
      return {
        durationMs: 0,
        native: { content: [], structuredContent: { done: true }, isError: false },
        output: { ok: true, code: 'OK', message: 'done' }
      };
    },
    close: async () => undefined
  };
  const gateway = new McpGatewayServer(
    [{ id: 'b', transport: 'http', endpoint: 'http://unused' }],
    { connectorFactory: () => connector, policy: { riskPolicy: { denyLevels: ['critical'] } } }
  );
  await gateway.initialize();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await gateway.connect(b);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(a);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name)).not.toContain('b__hidden');
    expect(tools.find((t) => t.name === 'b__visible')).toMatchObject({
      title: 'visible title',
      icons: [{ src: 'https://example.com/icon.png' }]
    });
    await expect(client.callTool({ name: 'b__critical', arguments: {} })).rejects.toMatchObject({
      data: { category: 'policy_denied' }
    });
    await expect(client.callTool({ name: 'b__hidden', arguments: {} })).rejects.toMatchObject({
      data: { category: 'policy_denied' }
    });
    expect(calls).toBe(0);
    expect(gateway.getInMemoryAuditEvents()[0]?.capabilityRiskLevel).toBe('critical');
  } finally {
    await client.close();
    await gateway.close();
  }
});

it('gateway shutdown waits for admitted audit writes and repeated close callers', async () => {
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((r) => {
    release = r;
  });
  const writing = new Promise<void>((r) => {
    entered = r;
  });
  const store = new JsonlAuditStore('/tmp/ai-mcp-test/audit.jsonl', {
    sink: async () => {
      entered();
      await blocked;
    }
  });
  const gateway = new McpGatewayServer([], { auditStore: store });
  await gateway.initialize();
  const write = store.record({
    timestamp: 'now',
    tenantId: 't',
    action: 'tools/call',
    toolName: 'probe',
    traceId: 't',
    decision: 'allow'
  });
  await writing;
  let closed = false;
  const closing = gateway.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((r) => setTimeout(r, 20));
    expect(closed).toBe(false);
  } finally {
    release();
    await write;
    await closing;
    await gateway.close();
    await store.close();
  }
});
