import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CONTEXT_META_KEY, type NativeToolResult, type ToolDescriptor } from '@ai-mcp/shared';
import { McpGatewayServer } from '../src/gateway-server.js';
import type { DownstreamConnector } from '../src/connectors/base.js';

type CapturedCall = {
  name: string;
  args: unknown;
  context?: { traceId?: string; runId?: string; taskId?: string };
};

function contextConnector(
  handler: (call: CapturedCall) => NativeToolResult
): DownstreamConnector & { calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const descriptor: ToolDescriptor = {
    name: 'probe',
    description: 'context probe',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }
  };
  return {
    calls,
    async listTools() {
      return [{ name: descriptor.name, description: 'probe', descriptor }];
    },
    async callTool(name, args, _signal, context) {
      const call = { name, args, ...(context ? { context } : {}) };
      calls.push(call);
      return {
        durationMs: 1,
        output: {
          ok: true,
          code: 'OK',
          message: 'Tool call succeeded',
          structuredContent: { ok: true }
        },
        native: handler(call)
      };
    },
    async close() {
      return;
    }
  };
}

async function connectFresh(gateway: McpGatewayServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverTransport);
  const client = new Client({ name: 'ctx-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return client;
}

async function startGatewayWith(connector: DownstreamConnector) {
  const gateway = new McpGatewayServer(
    [{ id: 'local', transport: 'http', endpoint: 'http://down/mcp' }],
    { connectorFactory: () => connector }
  );
  await gateway.initialize();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverTransport);
  const client = new Client({ name: 'ctx-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return { gateway, client };
}

describe('context and audit continuity', () => {
  it('propagates one trace from the caller _meta through the connector into the audit log', async () => {
    const connector = contextConnector(() => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { done: true },
      isError: false,
      _meta: { [CONTEXT_META_KEY]: { traceId: 'downstream-trace-9' } }
    }));
    const { gateway, client } = await startGatewayWith(connector);

    await client.callTool({
      name: 'local__probe',
      arguments: { q: 'x' },
      _meta: {
        [CONTEXT_META_KEY]: { traceId: 'caller-trace-1', runId: 'run-42', taskId: 'task-7' }
      }
    } as never);

    // Connector saw the same identity, and arguments stayed clean.
    expect(connector.calls).toHaveLength(1);
    expect(connector.calls[0]?.args).toEqual({ q: 'x' });
    expect(connector.calls[0]?.context).toMatchObject({
      traceId: 'caller-trace-1',
      runId: 'run-42',
      taskId: 'task-7'
    });

    // The audit event carries the same trace plus the downstream link.
    const events = gateway.getInMemoryAuditEvents();
    const last = events.at(-1);
    expect(last).toMatchObject({
      traceId: 'caller-trace-1',
      runId: 'run-42',
      taskId: 'task-7',
      outcome: 'success',
      decision: 'allow',
      downstreamTraceId: 'downstream-trace-9',
      downstream: { backendId: 'local', backendToolName: 'probe' }
    });

    await client.close();
    await gateway.close();
  });

  it('never mixes identities between clients that share request ids', async () => {
    const connector = contextConnector(() => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { done: true },
      isError: false
    }));
    const gateway = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://down/mcp' }],
      { connectorFactory: () => connector }
    );
    await gateway.initialize();

    // Two clients on the SAME gateway, both starting from JSON-RPC id 1.
    const clientA = await connectFresh(gateway);
    const clientB = await connectFresh(gateway);

    await Promise.all([
      clientA.callTool({
        name: 'local__probe',
        arguments: { q: 'a' },
        _meta: { [CONTEXT_META_KEY]: { traceId: 'trace-a' } }
      } as never),
      clientB.callTool({
        name: 'local__probe',
        arguments: { q: 'b' },
        _meta: { [CONTEXT_META_KEY]: { traceId: 'trace-b' } }
      } as never)
    ]);

    const traces = gateway.getInMemoryAuditEvents().map((event) => event.traceId);
    expect(traces).toContain('trace-a');
    expect(traces).toContain('trace-b');
    expect(new Set(traces).size).toBe(traces.length);

    await clientA.close();
    await clientB.close();
    await gateway.close();
  });

  it('falls back to the server runContext.runId only when the call carries none', async () => {
    const connector = contextConnector(() => ({
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { done: true },
      isError: false
    }));
    const gateway = new McpGatewayServer(
      [{ id: 'local', transport: 'http', endpoint: 'http://down/mcp' }],
      {
        connectorFactory: () => connector,
        runContext: { runId: 'server-default-run' }
      }
    );
    await gateway.initialize();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await gateway.connect(serverTransport);
    const client = new Client({ name: 'ctx', version: '0' });
    await client.connect(clientTransport);

    await client.callTool({ name: 'local__probe', arguments: { q: 'x' } });
    expect(connector.calls[0]?.context).toMatchObject({ runId: 'server-default-run' });

    await client.callTool({
      name: 'local__probe',
      arguments: { q: 'y' },
      _meta: { [CONTEXT_META_KEY]: { traceId: 't', runId: 'call-run' } }
    } as never);
    expect(connector.calls[1]?.context).toMatchObject({ runId: 'call-run' });

    await client.close();
    await gateway.close();
  });

  it('keeps business task ids in payloads from overwriting call identity', async () => {
    const connector = contextConnector(() => ({
      content: [{ type: 'text', text: 'task' }],
      structuredContent: { task: { id: 'task-in-payload', state: 'failed' } },
      isError: false
    }));
    const { gateway, client } = await startGatewayWith(connector);

    const result = await client.callTool({
      name: 'local__probe',
      arguments: { q: 'failed-task' },
      _meta: { [CONTEXT_META_KEY]: { traceId: 'query-trace', taskId: 'query-task' } }
    } as never);

    // Successful query of a failed task stays successful.
    expect(result.isError).toBeFalsy();
    const events = gateway.getInMemoryAuditEvents();
    expect(events.at(-1)).toMatchObject({
      outcome: 'success',
      traceId: 'query-trace',
      taskId: 'query-task'
    });

    await client.close();
    await gateway.close();
  });
});
