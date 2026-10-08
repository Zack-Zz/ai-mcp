import { describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError as SdkMcpError } from '@modelcontextprotocol/sdk/types.js';
import { createSchemaCompiler, type NativeToolResult, type ToolDescriptor } from '@ai-mcp/shared';
import { McpGatewayServer } from '../src/gateway-server.js';
import type { BackendSpec } from '../src/types.js';
import type { DownstreamConnector } from '../src/connectors/base.js';

type DownstreamHandler = (request: {
  params?: { name?: string; arguments?: Record<string, unknown> };
}) => unknown;

class StubConnector implements DownstreamConnector {
  public callCount = 0;
  public closeCount = 0;

  public constructor(
    private readonly tools: ToolDescriptor[],
    private readonly handler: DownstreamHandler
  ) {}

  public async listTools() {
    return this.tools.map((descriptor) => ({
      name: descriptor.name,
      description: descriptor.description ?? '',
      descriptor
    }));
  }

  public async callTool(name: string, args: unknown, signal?: AbortSignal) {
    void signal;
    this.callCount += 1;
    const raw = this.handler({ params: { name, arguments: args as Record<string, unknown> } });
    const native = raw as NativeToolResult;
    return {
      durationMs: 5,
      output: native.isError
        ? { ok: false, code: 'TOOL_FAILED', message: 'downstream failure' }
        : {
            ok: true,
            code: 'OK',
            message: 'Tool call succeeded',
            structuredContent: native.structuredContent
          },
      native
    };
  }

  public async close(): Promise<void> {
    this.closeCount += 1;
  }
}

async function startGateway(options: {
  tools: ToolDescriptor[];
  handler: DownstreamHandler;
  serverOptions?: ConstructorParameters<typeof McpGatewayServer>[1];
}) {
  const connector = new StubConnector(options.tools, options.handler);
  const baseBackend: BackendSpec = {
    id: 'local',
    transport: 'http',
    endpoint: 'http://downstream/mcp'
  };
  const backends: BackendSpec[] = [baseBackend];
  const gateway = new McpGatewayServer(backends, {
    connectorFactory: () => connector,
    ...options.serverOptions
  });
  await gateway.initialize();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await gateway.connect(serverTransport);
  const client = new Client({ name: 'gateway-test-client', version: '0.0.1' });
  await client.connect(clientTransport);
  return { gateway, client, connector };
}

const echoDescriptor: ToolDescriptor = {
  name: 'echo',
  description: 'Echo back the input payload',
  inputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  outputSchema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false
  },
  _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
};

describe('gateway server end-to-end over in-memory MCP', () => {
  it('publishes wrapped output schemas that independently validate real results', async () => {
    const { gateway, client, connector } = await startGateway({
      tools: [echoDescriptor],
      handler: ({ params }) => ({
        content: [{ type: 'text', text: JSON.stringify({ text: params?.arguments?.text }) }],
        structuredContent: { text: params?.arguments?.text },
        isError: false
      })
    });

    const list = await client.listTools();
    const advertised = list.tools.find((tool) => tool.name === 'local__echo');
    if (!advertised) {
      throw new Error(`local__echo missing: ${JSON.stringify(list.tools.map((t) => t.name))}`);
    }

    // The advertised schema describes the OUTER standard envelope, not the
    // downstream {text} payload.
    const schema = advertised.outputSchema as Record<string, unknown>;
    const properties = schema.properties as Record<string, unknown>;
    expect(properties.ok).toBeDefined();
    expect(schema.required).toEqual(['ok', 'code', 'message']);

    const result = (await client.callTool({
      name: 'local__echo',
      arguments: { text: 'independent-validation' }
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.ok).toBe(true);
    expect((result.structuredContent?.structuredContent as { text: string }).text).toBe(
      'independent-validation'
    );

    // Independent validation with a fresh compiler (A03).
    const compiler = createSchemaCompiler();
    const validator = compiler.compile(schema);
    expect(validator.validate(result.structuredContent).valid).toBe(true);
    expect(
      validator.validate({ ...result.structuredContent, structuredContent: { text: 42 } }).valid
    ).toBe(false);

    expect(connector.callCount).toBe(1);
    await client.close();
    await gateway.close();
  });

  it('upflows native isError results as tool failures and records tool_error audits', async () => {
    const { gateway, client } = await startGateway({
      tools: [echoDescriptor],
      handler: () => ({
        content: [{ type: 'text', text: 'downstream exploded' }],
        structuredContent: { reason: 'out_of_stock' },
        isError: true
      })
    });

    const result = (await client.callTool({
      name: 'local__echo',
      arguments: { text: 'x' }
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.ok).toBe(false);

    const events = gateway.getInMemoryAuditEvents();
    expect(events.at(-1)).toMatchObject({ outcome: 'tool_error', decision: 'allow' });

    await client.close();
    await gateway.close();
  });

  it('advertises envelope schemas that validate standard ok:true results end to end', async () => {
    const standardDescriptor: ToolDescriptor = {
      ...echoDescriptor,
      name: 'report.ok',
      outputSchema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          code: { type: 'string' },
          message: { type: 'string' },
          structuredContent: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
            additionalProperties: false
          }
        },
        required: ['ok', 'code', 'message'],
        additionalProperties: false
      },
      _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
    };
    const { gateway, client } = await startGateway({
      tools: [standardDescriptor],
      handler: () => ({
        content: [{ type: 'text', text: 'std-ok' }],
        structuredContent: {
          ok: true,
          code: 'OK',
          message: 'done',
          structuredContent: { done: true }
        },
        isError: false
      })
    });

    const list = await client.listTools();
    const advertised = list.tools.find((tool) => tool.name === 'local__report.ok');
    if (!advertised) {
      throw new Error(`local__report.ok missing: ${JSON.stringify(list.tools.map((t) => t.name))}`);
    }

    const result = (await client.callTool({
      name: 'local__report.ok',
      arguments: { text: 'x' }
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.structuredContent).toEqual({ done: true });

    // Independent validation from the UPSTREAM-advertised schema: the outer
    // envelope must validate, and a wrong inner payload must be rejected.
    const compiler = createSchemaCompiler();
    const validator = compiler.compile(advertised.outputSchema as Record<string, unknown>);
    expect(validator.validate(result.structuredContent).valid).toBe(true);
    expect(
      validator.validate({ ...result.structuredContent, structuredContent: { done: 'no' } }).valid
    ).toBe(false);

    await client.close();
    await gateway.close();
  });

  it('turns standard ok:false into tool failures without double wrapping', async () => {
    const standardDescriptor: ToolDescriptor = {
      ...echoDescriptor,
      name: 'report',
      _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
    };
    const { gateway, client } = await startGateway({
      tools: [standardDescriptor],
      handler: () => ({
        content: [{ type: 'text', text: 'std' }],
        structuredContent: { ok: false, code: 'REJECTED', message: 'quota exceeded' },
        isError: false
      })
    });

    const result = (await client.callTool({
      name: 'local__report',
      arguments: { text: 'x' }
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, code: 'REJECTED' });
    expect(result.structuredContent?.structuredContent).toBeUndefined();

    const events = gateway.getInMemoryAuditEvents();
    expect(events.at(-1)).toMatchObject({ outcome: 'tool_error', resultCode: 'TOOL_FAILED' });

    await client.close();
    await gateway.close();
  });

  it('keeps native business ok:false data and failed-task queries successful', async () => {
    const taskDescriptor: ToolDescriptor = {
      ...echoDescriptor,
      name: 'tasks.get',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { task: { type: 'object' } },
        required: ['task']
      }
    };
    const { gateway, client } = await startGateway({
      tools: [taskDescriptor],
      handler: () => ({
        content: [{ type: 'text', text: 'task' }],
        structuredContent: { task: { state: 'failed', id: 'task-7' } },
        isError: false
      })
    });

    const result = (await client.callTool({
      name: 'local__tasks.get',
      arguments: {}
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent?.ok).toBe(true);
    expect(result.structuredContent?.structuredContent).toEqual({
      task: { state: 'failed', id: 'task-7' }
    });

    const events = gateway.getInMemoryAuditEvents();
    expect(events.at(-1)).toMatchObject({ outcome: 'success' });

    await client.close();
    await gateway.close();
  });

  it('rejects invalid inputs before the downstream is called', async () => {
    const { gateway, client, connector } = await startGateway({
      tools: [echoDescriptor],
      handler: () => ({ content: [], isError: false })
    });

    const result = (await client.callTool({
      name: 'local__echo',
      arguments: { wrong: true }
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBe(true);
    expect(result.structuredContent?.code).toBe('INVALID_PARAMS');
    expect(connector.callCount).toBe(0);

    const events = gateway.getInMemoryAuditEvents();
    expect(events.at(-1)).toMatchObject({ outcome: 'protocol_error', decision: 'allow' });

    await client.close();
    await gateway.close();
  });

  it('surfaces policy denials as numeric JSON-RPC errors with machine data', async () => {
    const { gateway, client } = await startGateway({
      tools: [echoDescriptor],
      handler: () => ({ content: [], isError: false }),
      serverOptions: {
        policy: { allowTools: [] }
      }
    });

    const error = await client.callTool({ name: 'local__echo', arguments: { text: 'x' } }).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(SdkMcpError);
    const mcpError = error as SdkMcpError;
    expect(mcpError.code).toBe(-32020);
    expect((mcpError.data as { category?: string })?.category).toBe('policy_denied');

    const events = gateway.getInMemoryAuditEvents();
    expect(events.at(-1)).toMatchObject({ decision: 'deny', outcome: 'protocol_error' });

    await client.close();
    await gateway.close();
  });

  it('keeps unknown tools as -32602 protocol errors', async () => {
    const { gateway, client } = await startGateway({
      tools: [echoDescriptor],
      handler: () => ({ content: [], isError: false })
    });

    const error = await client.callTool({ name: 'local__missing', arguments: {} }).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(SdkMcpError);
    expect((error as SdkMcpError).code).toBe(-32602);

    await client.close();
    await gateway.close();
  });

  it('is idempotent on initialize and releases backends when discovery fails', async () => {
    const failingConnector = new (class implements DownstreamConnector {
      public closed = false;
      public async listTools(): Promise<never> {
        throw new Error('discovery down');
      }
      public async callTool(): Promise<never> {
        throw new Error('unreachable');
      }
      public async close(): Promise<void> {
        this.closed = true;
      }
    })();

    const gateway = new McpGatewayServer(
      [{ id: 'broken', transport: 'http', endpoint: 'http://down/mcp' }],
      { connectorFactory: () => failingConnector }
    );

    await expect(gateway.initialize()).rejects.toThrowError('discovery down');
    expect(failingConnector.closed).toBe(true);

    const second = new McpGatewayServer(
      [{ id: 'ok', transport: 'http', endpoint: 'http://down/mcp' }],
      { connectorFactory: () => new StubConnector([echoDescriptor], () => ({})) }
    );
    await second.initialize();
    await second.initialize();
    expect(second.getInMemoryAuditEvents()).toHaveLength(0);
    await second.close();
  });

  it('does not re-execute the tool when audit persistence fails', async () => {
    const failingAudit = {
      record: vi.fn(async () => {
        throw new Error('disk full');
      })
    };
    const { gateway, client, connector } = await startGateway({
      tools: [echoDescriptor],
      handler: ({ params }) => ({
        content: [{ type: 'text', text: 'ok' }],
        structuredContent: { text: params?.arguments?.text },
        isError: false
      }),
      serverOptions: { auditStore: failingAudit }
    });

    const error = await client.callTool({ name: 'local__echo', arguments: { text: 'once' } }).then(
      () => undefined,
      (reason: unknown) => reason
    );
    expect(error).toBeInstanceOf(SdkMcpError);
    const mcpError = error as SdkMcpError;
    expect(mcpError.code).toBe(-32603);
    expect((mcpError.data as { category?: string })?.category).toBe('audit_unavailable');
    expect((mcpError.data as { operationCompleted?: boolean })?.operationCompleted).toBe(true);
    // The tool ran exactly once despite the audit failure.
    expect(connector.callCount).toBe(1);
    expect(failingAudit.record).toHaveBeenCalledTimes(1);

    await client.close();
    await gateway.close();
  });
});
