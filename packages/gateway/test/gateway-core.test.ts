import { isJsonObject } from '@ai-mcp/shared';
import { describe, expect, it, vi } from 'vitest';
import { McpGatewayCore } from '../src/gateway-core.js';
import type { BackendSpec } from '../src/types.js';
import type { DownstreamConnector } from '../src/connectors/base.js';

type MockConnector = DownstreamConnector & {
  listToolsMock: ReturnType<typeof vi.fn>;
  callToolMock: ReturnType<typeof vi.fn>;
  closeMock: ReturnType<typeof vi.fn>;
};

function createMockConnector(tools: { name: string; description: string }[]): MockConnector {
  const listToolsMock = vi.fn(async () =>
    tools.map((tool) => ({
      ...tool,
      descriptor: {
        name: tool.name,
        description: tool.description,
        inputSchema: { type: 'object' }
      }
    }))
  );
  const callToolMock = vi.fn(
    async (
      name: string,
      args: unknown,
      signal?: AbortSignal,
      context?: { traceId?: string; runId?: string; taskId?: string }
    ) => {
      const payload = {
        name,
        args: isJsonObject(args) ? args : {},
        aborted: signal?.aborted ?? false,
        traceId: context?.traceId ?? null
      };
      return {
        durationMs: 12,
        output: {
          ok: true,
          code: 'OK',
          message: 'Tool call succeeded',
          structuredContent: payload
        },
        native: {
          content: [{ type: 'text', text: 'ok' }],
          structuredContent: payload,
          isError: false
        }
      };
    }
  );
  const closeMock = vi.fn(async () => undefined);

  return {
    listToolsMock,
    callToolMock,
    closeMock,
    async listTools() {
      return await listToolsMock();
    },
    async callTool(
      name: string,
      args: unknown,
      signal?: AbortSignal,
      context?: { traceId?: string; runId?: string; taskId?: string }
    ) {
      return await callToolMock(name, args, signal, context);
    },
    async close() {
      await closeMock();
    }
  };
}

describe('McpGatewayCore', () => {
  it('builds backend__tool mappings from multiple backends', async () => {
    const backends: BackendSpec[] = [
      { id: 'a', transport: 'http', endpoint: 'http://backend-a/mcp' },
      { id: 'b', transport: 'http', endpoint: 'http://backend-b/mcp' }
    ];

    const connectors = new Map<string, MockConnector>([
      ['a', createMockConnector([{ name: 'echo', description: 'Echo from A' }])],
      ['b', createMockConnector([{ name: 'time', description: 'Time from B' }])]
    ]);

    const gateway = new McpGatewayCore(backends, (backend) => {
      const connector = connectors.get(backend.id);
      if (!connector) {
        throw new Error(`missing connector for ${backend.id}`);
      }
      return connector;
    });

    const tools = await gateway.refreshTools();
    expect(tools.map((tool) => tool.publicName).sort()).toEqual(['a__echo', 'b__time']);
  });

  it('routes mapped tools to the right backend tool', async () => {
    const backends: BackendSpec[] = [
      { id: 'a', transport: 'http', endpoint: 'http://backend-a/mcp' }
    ];

    const connector = createMockConnector([{ name: 'echo', description: 'Echo from A' }]);
    const gateway = new McpGatewayCore(backends, () => connector);

    await gateway.refreshTools();

    const output = await gateway.callMappedTool('a__echo', { text: 'hello' });

    expect(connector.callToolMock).toHaveBeenCalledWith(
      'echo',
      { text: 'hello' },
      undefined,
      expect.objectContaining({ resultContract: 'legacy-auto', traceId: expect.any(String) })
    );
    expect(output).toMatchObject({
      backendId: 'a',
      backendToolName: 'echo',
      durationMs: 12,
      output: {
        ok: true,
        code: 'OK',
        message: 'Tool call succeeded',
        structuredContent: {
          name: 'echo',
          args: { text: 'hello' },
          aborted: false,
          traceId: expect.any(String)
        }
      },
      native: {
        isError: false,
        structuredContent: { name: 'echo', args: { text: 'hello' } }
      },
      entry: {
        publicName: 'a__echo',
        backendToolName: 'echo'
      }
    });
  });

  it('propagates abort signal to downstream connector', async () => {
    const backends: BackendSpec[] = [
      { id: 'a', transport: 'http', endpoint: 'http://backend-a/mcp' }
    ];

    const connector = createMockConnector([{ name: 'echo', description: 'Echo from A' }]);
    const gateway = new McpGatewayCore(backends, () => connector);

    await gateway.refreshTools();

    const controller = new AbortController();
    controller.abort();

    await gateway.callMappedTool('a__echo', { text: 'abort' }, controller.signal);

    expect(connector.callToolMock).toHaveBeenCalledTimes(1);
    const signalArg = connector.callToolMock.mock.calls[0]?.[2] as AbortSignal;
    expect(signalArg.aborted).toBe(true);
  });

  it('closes every connector even when one close fails, and is idempotent', async () => {
    const backends: BackendSpec[] = [
      { id: 'ok', transport: 'http', endpoint: 'http://backend-ok/mcp' },
      { id: 'bad', transport: 'http', endpoint: 'http://backend-bad/mcp' }
    ];

    const okConnector = createMockConnector([{ name: 'echo', description: 'Echo' }]);
    const badConnector = createMockConnector([{ name: 'time', description: 'Time' }]);
    badConnector.closeMock.mockRejectedValueOnce(new Error('close failed'));

    const gateway = new McpGatewayCore(backends, (backend) =>
      backend.id === 'ok' ? okConnector : badConnector
    );

    await gateway.close();
    await gateway.close();
    // Idempotent close: each connector closed exactly once despite the
    // failing one; the failure never blocked the other.
    expect(okConnector.closeMock).toHaveBeenCalledTimes(1);
    expect(badConnector.closeMock).toHaveBeenCalledTimes(1);
  });

  it('validates input against the catalog schema before calling the connector', async () => {
    const connector = createMockConnector([]);

    // The mock descriptor advertises a permissive object schema; register a
    // stricter one through the descriptor returned by the connector.
    const strict = {
      ...connector,
      listTools: async () => [
        {
          name: 'strict.tool',
          description: 'strict',
          descriptor: {
            name: 'strict.tool',
            description: 'strict',
            inputSchema: {
              type: 'object',
              properties: { q: { type: 'string' } },
              required: ['q'],
              additionalProperties: false
            }
          }
        }
      ]
    };
    const strictGateway = new McpGatewayCore(
      [{ id: 'a', transport: 'http', endpoint: 'http://backend-a/mcp' }],
      () => strict as unknown as MockConnector
    );
    await strictGateway.refreshTools();

    await expect(
      strictGateway.callMappedTool('a__strict_tool', { wrong: 1 })
    ).rejects.toMatchObject({ category: 'invalid_request' });
    expect(connector.callToolMock).not.toHaveBeenCalled();
  });

  it('throws when mapped tool does not exist', async () => {
    const backends: BackendSpec[] = [
      { id: 'a', transport: 'http', endpoint: 'http://backend-a/mcp' }
    ];

    const connector = createMockConnector([{ name: 'echo', description: 'Echo from A' }]);
    const gateway = new McpGatewayCore(backends, () => connector);

    await gateway.refreshTools();

    await expect(gateway.callMappedTool('a__missing', {})).rejects.toThrowError(
      'Mapped tool not found: a__missing'
    );
  });
});
