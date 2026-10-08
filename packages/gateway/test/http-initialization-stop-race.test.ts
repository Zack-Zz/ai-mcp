import { expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from '../../mcp-server/src/server.js';
import { McpGatewayServer } from '../src/gateway-server.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

it.each([
  ['server', 'stateful'],
  ['server', 'stateless'],
  ['gateway', 'stateful'],
  ['gateway', 'stateless']
] as const)(
  '%s %s cannot revive protocol resources when start finishes after owner.close',
  async (kind, sessionMode) => {
    const entered = gate();
    const resume = gate();
    const transports = new Set<StreamableHTTPServerTransport>();
    const originalStart = StreamableHTTPServerTransport.prototype.start;
    // Retain the real SDK start. The barrier models the asynchronous boundary
    // at which shutdown can dispose a pending transport before connect returns.
    const startBarrier = vi
      .spyOn(StreamableHTTPServerTransport.prototype, 'start')
      .mockImplementation(async function (this: StreamableHTTPServerTransport) {
        transports.add(this);
        await originalStart.call(this);
        entered.release();
        await resume.promise;
      });
    const owner =
      kind === 'server'
        ? createServer({ shutdownGraceMs: 30 })
        : new McpGatewayServer([], { shutdownGraceMs: 30 });
    if (owner instanceof McpGatewayServer) await owner.initialize();
    const listener = owner.startHttp({ port: 0, sessionMode });
    await once(listener, 'listening');
    const port = (listener.address() as AddressInfo).port;
    const lifecycles: unknown = Reflect.get(owner, 'httpLifecycles');
    const lifecycle: unknown = Array.isArray(lifecycles) ? lifecycles[0] : undefined;
    const request = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'initialization-stop', version: '1' }
        }
      })
    }).then(
      async (response) => ({ status: response.status, body: await response.text() }),
      () => ({ status: 0 })
    );
    try {
      await entered.promise;
      await owner.close();
      resume.release();
      await request;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const captured = transports.values().next().value;
      if (!captured) throw new Error('SDK transport was never started');
      const webTransport: unknown = Reflect.get(captured, '_webStandardTransport');
      if (typeof webTransport !== 'object' || webTransport === null)
        throw new Error('Missing real SDK web transport');
      const streams: unknown = Reflect.get(webTransport, '_streamMapping');
      if (!(streams instanceof Map)) throw new Error('Missing real SDK stream ownership map');
      expect(Reflect.get(webTransport, '_initialized')).toBe(false);
      expect(captured.sessionId).toBeUndefined();
      expect(streams.size).toBe(0);
      expect(owner.activeProtocolInstanceCount).toBe(0);
      if (typeof lifecycle === 'object' && lifecycle !== null)
        expect(Reflect.get(lifecycle, 'sessionCount')).toBe(0);
      const rebind = createTcpServer();
      await new Promise<void>((resolve, reject) => {
        rebind.once('error', reject);
        rebind.listen(port, '127.0.0.1', resolve);
      });
      await new Promise<void>((resolve) => rebind.close(() => resolve()));
    } finally {
      resume.release();
      await request;
      await owner.close();
      startBarrier.mockRestore();
    }
  }
);
