import { describe, expect, it } from 'vitest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
  McpError
} from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../../mcp-server/src/index.js';
import { McpClient, createClient } from '../src/client.js';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function linked(server: Server) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return new McpClient(clientTransport, 1000);
}

describe('overall review: client discovery, contract and ownership', () => {
  it('does not erase a typed discovery fault even if the wire code is MethodNotFound', async () => {
    const server = new Server(
      { name: 'typed-discovery', version: '1' },
      { capabilities: { tools: {} } }
    );
    let calls = 0;
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      throw new McpError(-32601, 'Invalid descriptor store', {
        category: 'invalid_result',
        projectCode: 'INVALID_RESULT'
      });
    });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      calls++;
      return { content: [], structuredContent: { done: true } };
    });
    const client = await linked(server);
    try {
      await expect(client.callToolResult('probe', {})).rejects.toMatchObject({
        category: 'invalid_result'
      });
      expect(calls).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('propagates discovery internal errors without caching an unchecked directory', async () => {
    let lists = 0;
    let calls = 0;
    const server = new Server(
      { name: 'discovery-errors', version: '1' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => {
      lists++;
      if (lists <= 2) throw new McpError(-32603, 'Discovery storage unavailable');
      return {
        tools: [
          {
            name: 'orders',
            inputSchema: {
              type: 'object',
              properties: { quantity: { type: 'number' } },
              required: ['quantity']
            }
          }
        ]
      };
    });
    server.setRequestHandler(CallToolRequestSchema, async () => {
      calls++;
      return { content: [], structuredContent: { bad: true } };
    });
    const client = await linked(server);
    try {
      for (let index = 0; index < 2; index++) {
        await expect(client.callToolResult('orders', { quantity: 'many' })).rejects.toMatchObject({
          category: 'internal'
        });
      }
      await expect(client.callToolResult('orders', { quantity: 'many' })).rejects.toMatchObject({
        category: 'invalid_params'
      });
      expect(lists).toBe(3);
      expect(calls).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('allows the explicit native contract override while retaining the complete source schema', async () => {
    const server = new Server({ name: 'override', version: '1' }, { capabilities: { tools: {} } });
    let invalid = false;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'catalog',
          inputSchema: { type: 'object' },
          outputSchema: {
            type: 'object',
            properties: { sku: { type: 'string' } },
            required: ['sku'],
            additionalProperties: false
          },
          _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
        }
      ]
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [],
      structuredContent: { sku: invalid ? 7 : 'sku-1' }
    }));
    const client = await linked(server);
    try {
      expect(
        (await client.callToolResult('catalog', {}, { resultContract: 'native-json/v1' }))
          .structuredContent
      ).toEqual({ sku: 'sku-1' });
      invalid = true;
      await expect(
        client.callToolResult('catalog', {}, { resultContract: 'native-json/v1' })
      ).rejects.toMatchObject({ category: 'invalid_result' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('decodes declared standard text JSON without an output schema and preserves failure semantics', async () => {
    const server = new Server(
      { name: 'text-standard', version: '1' },
      { capabilities: { tools: {} } }
    );
    let ok = true;
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'legacy',
          inputSchema: { type: 'object' },
          _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
        }
      ]
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ok, code: ok ? 'OK' : 'FAILED_TASK', message: 'task state' })
        }
      ]
    }));
    const client = await linked(server);
    try {
      expect((await client.callToolResult('legacy', {})).isError).toBe(false);
      ok = false;
      expect((await client.callToolResult('legacy', {})).isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('does not use text fallback to bypass a declared structured output schema', async () => {
    const server = new Server(
      { name: 'text-structured', version: '1' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'strict',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object', properties: { ok: { const: true } }, required: ['ok'] },
          _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
        }
      ]
    }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: 'text', text: '{"ok":true,"code":"OK","message":"done"}' }]
    }));
    const client = await linked(server);
    try {
      await expect(client.callToolResult('strict', {})).rejects.toMatchObject({
        category: 'invalid_result'
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects connect after close before creating a real HTTP session', async () => {
    const owner = createServer();
    const listener = owner.startHttp({ port: 0, sessionMode: 'stateful' });
    await once(listener, 'listening');
    const client = createClient({
      transport: 'http',
      endpoint: `http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`
    });
    try {
      await client.close();
      await expect(client.connect()).rejects.toMatchObject({ category: 'backend_unavailable' });
      expect(owner.activeProtocolInstanceCount).toBe(0);
    } finally {
      await client.close();
      await owner.close();
    }
  });

  it('counts a shared initial connection against the discovery budget without closing another waiter', async () => {
    const admitted = barrier();
    const release = barrier();
    const server = new Server({ name: 'slow-init', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(InitializeRequestSchema, async (request) => {
      admitted.release();
      await release.promise;
      return {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'slow-init', version: '1' }
      };
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'probe', inputSchema: { type: 'object' } }]
    }));
    const client = await linked(server);
    const first = client.discoverTools({ timeoutMs: 20 }).then(
      () => 'success',
      (error: unknown) => (error as { category: string }).category
    );
    await admitted.promise;
    const second = client.discoverTools({ timeoutMs: 1000 });
    try {
      expect(
        await Promise.race([
          first,
          new Promise<string>((resolve) => setTimeout(() => resolve('still-waiting'), 100))
        ])
      ).toBe('backend_timeout');
      release.release();
      expect((await second).map((tool) => tool.name)).toEqual(['probe']);
    } finally {
      release.release();
      await first;
      await second;
      await client.close();
      await server.close();
    }
  });

  it('rejects a pre-cancelled discovery before initiating an SDK handshake', async () => {
    let initializations = 0;
    const server = new Server(
      { name: 'cancel-init', version: '1' },
      { capabilities: { tools: {} } }
    );
    server.setRequestHandler(InitializeRequestSchema, async (request) => {
      initializations++;
      return {
        protocolVersion: request.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'cancel-init', version: '1' }
      };
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
    const client = await linked(server);
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(client.discoverTools({ signal: controller.signal })).rejects.toMatchObject({
        category: 'cancelled'
      });
      expect(initializations).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
