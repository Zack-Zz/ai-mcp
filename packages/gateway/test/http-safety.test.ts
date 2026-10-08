import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, type AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from '../../mcp-server/src/index.js';
import { McpGatewayServer } from '../src/gateway-server.js';

it.each(['server', 'gateway'])(
  '%s cannot create a new listener after terminal close',
  async (kind) => {
    const owner = kind === 'server' ? createServer() : new McpGatewayServer([]);
    await owner.close();
    let error: unknown;
    let listener: ReturnType<typeof owner.startHttp> | undefined;
    try {
      listener = owner.startHttp({ port: 0 });
    } catch (cause) {
      error = cause;
    }
    if (listener) {
      if (!listener.listening) await once(listener, 'listening');
      await new Promise<void>((resolve) => listener?.close(() => resolve()));
    }
    expect(error).toBeInstanceOf(Error);
  }
);

it.each(['server', 'gateway'])(
  '%s rejects a null JSON envelope without terminating the process',
  async (kind) => {
    const child = fork(
      fileURLToPath(new URL('./fixtures/http-safety.ts', import.meta.url)),
      [kind],
      {
        execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url))
        },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      }
    );
    const ready = once(child, 'message');
    const [message] = await ready;
    const port = (message as { port: number }).port;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream'
        },
        body: 'null'
      });
      expect(response.status).toBe(400);
      expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);
      expect(child.exitCode).toBeNull();
    } finally {
      if (child.exitCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
  }
);

it.each(['server', 'gateway'])(
  '%s returns HTTP 413 before closing an oversized request connection',
  async (kind) => {
    const owner = kind === 'server' ? createServer() : new McpGatewayServer([]);
    if (owner instanceof McpGatewayServer) await owner.initialize();
    const listener = owner.startHttp({ port: 0, maxBodySizeBytes: 64 });
    await once(listener, 'listening');
    try {
      const res = await fetch(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`, {
        method: 'POST',
        body: 'x'.repeat(200)
      });
      expect(res.status).toBe(413);
    } finally {
      await owner.close();
    }
  }
);

it.each(['server', 'gateway'])(
  '%s bounds shutdown when a client never finishes its HTTP body',
  async (kind) => {
    const owner =
      kind === 'server'
        ? createServer({ shutdownGraceMs: 30 })
        : new McpGatewayServer([], { shutdownGraceMs: 30 });
    if (owner instanceof McpGatewayServer) await owner.initialize();
    const listener = owner.startHttp({ port: 0 });
    await once(listener, 'listening');
    const socket = createConnection({
      host: '127.0.0.1',
      port: (listener.address() as AddressInfo).port
    });
    socket.on('error', () => undefined);
    await once(socket, 'connect');
    const admitted = once(listener, 'request');
    socket.write('POST /mcp HTTP/1.1\r\nHost: localhost\r\nContent-Length: 100\r\n\r\n{');
    await admitted;
    const closing = owner.close();
    try {
      expect(
        await Promise.race([
          closing.then(() => 'closed'),
          new Promise<string>((r) => setTimeout(() => r('hung'), 400))
        ])
      ).toBe('closed');
    } finally {
      socket.destroy();
      await closing;
    }
    expect(owner.activeProtocolInstanceCount).toBe(0);
  }
);
