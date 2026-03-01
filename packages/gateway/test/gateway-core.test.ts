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
  const listToolsMock = vi.fn(async () => tools);
  const callToolMock = vi.fn(async (name: string, args: unknown, signal?: AbortSignal) => ({
    name,
    args,
    aborted: signal?.aborted ?? false
  }));
  const closeMock = vi.fn(async () => undefined);

  return {
    listToolsMock,
    callToolMock,
    closeMock,
    async listTools() {
      return await listToolsMock();
    },
    async callTool(name: string, args: unknown, signal?: AbortSignal) {
      return await callToolMock(name, args, signal);
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

    expect(connector.callToolMock).toHaveBeenCalledWith('echo', { text: 'hello' }, undefined);
    expect(output).toEqual({
      name: 'echo',
      args: { text: 'hello' },
      aborted: false
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
