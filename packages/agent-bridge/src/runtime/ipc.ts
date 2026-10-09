import { createServer, type Socket } from 'node:net';
import { chmod, lstat, unlink, rmdir } from 'node:fs/promises';
import type { BridgeConfig } from '../contracts/validation.js';
import { parseConfig } from '../contracts/validation.js';
import { BridgeError } from '../contracts/errors.js';
import {
  assertPrivate,
  endpoint,
  claimRuntime,
  releaseRuntime,
  credential
} from '../client/security.js';
import {
  MAX_FRAME_BYTES,
  parseRequest,
  errorReply,
  requestId,
  object
} from '../client/protocol.js';
import type { RpcRequest } from '../client/protocol.js';
import { ReplayWindow, signReply, verifyRequest } from '../client/authentication.js';
import { digest } from './journal.js';
import type { OperationReply } from '../contracts/types.js';
export type AppPort = {
  dispatch(callerRef: string, operation: string, args: unknown): Promise<unknown>;
  close(): Promise<void>;
  idle(): Promise<void>;
};
export type RuntimeServer = { socketPath: string; close(): Promise<void>; closed: Promise<void> };
export async function serveRuntime(
  config: BridgeConfig,
  options: { application?: AppPort } = {}
): Promise<RuntimeServer> {
  const cfg = parseConfig(config);
  const target = await endpoint(cfg);
  const binding = await claimRuntime(target);
  const bindingHash = digest(binding);
  const replay = new ReplayWindow();
  let app: AppPort;
  try {
    for (const caller of cfg.clients) await credential(target, caller, true);
    try {
      const existing = await lstat(target.socketPath);
      assertPrivate(existing, 'socket');
      await unlink(target.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    app =
      options.application ??
      (await (await import('../application/service.js')).BridgeApplication.open(cfg));
  } catch (error) {
    await releaseRuntime(target, binding);
    throw error;
  }
  const sockets = new Set<Socket>();
  let closing: Promise<void> | undefined;
  let closeResolve!: () => void;
  const closed = new Promise<void>((resolve) => {
    closeResolve = resolve;
  });
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(55000, () => socket.destroy());
    let buffer = Buffer.alloc(0);
    let accepted = false;
    let authentication: { request: RpcRequest; token: string } | undefined;
    const reply = (value: OperationReply) => {
      if (socket.destroyed) return;
      const signed = (body: OperationReply) =>
        authentication
          ? signReply(body, authentication.request, authentication.token, bindingHash)
          : body;
      let frame = JSON.stringify(signed(value)) + '\n';
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES)
        frame =
          JSON.stringify(
            signed(
              errorReply(
                value.operation,
                new BridgeError('OUTPUT_LIMIT', 'Control response exceeds its limit', 'unknown'),
                value.requestId
              )
            )
          ) + '\n';
      socket.end(frame);
    };
    socket.on('data', (chunk: Buffer) => {
      if (accepted) {
        socket.destroy();
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_FRAME_BYTES) {
        accepted = true;
        reply(
          errorReply('unknown', new BridgeError('INPUT_LIMIT', 'Control request exceeds its limit'))
        );
        return;
      }
      const newline = buffer.indexOf(10);
      if (newline < 0) return;
      accepted = true;
      void (async () => {
        let operation = 'unknown';
        let id: string | undefined;
        try {
          if (buffer.subarray(newline + 1).length)
            throw new BridgeError(
              'INVALID_ARGUMENT',
              'One request per control connection is required'
            );
          const request = parseRequest(JSON.parse(buffer.subarray(0, newline).toString('utf8')));
          operation = request.operation;
          id = requestId(request.args);
          if (closing) throw new BridgeError('RUNTIME_STOPPING', 'Runtime is stopping');
          if (request.configHash !== target.configHash)
            throw new BridgeError('CONFIG_MISMATCH', 'Runtime configuration does not match');
          const caller = cfg.clients.find((client) => client.id === request.callerRef);
          if (!caller)
            throw new BridgeError('AUTH_REQUIRED', 'Configured control identity is required');
          const token = await credential(target, caller);
          verifyRequest(request, token);
          authentication = { request, token };
          if (request.bindingHash !== bindingHash)
            throw new BridgeError(
              'RUNTIME_UNAVAILABLE',
              'Control request belongs to a different runtime binding'
            );
          replay.consume(request);
          if (operation === 'runtime.handshake') {
            const args = object(request.args);
            if (Object.keys(args).length)
              throw new BridgeError(
                'INVALID_ARGUMENT',
                'Runtime handshake does not accept arguments'
              );
            reply({ apiVersion: 'agent-bridge/v1', operation, data: { connected: true } });
            return;
          }
          if (operation === 'runtime.stop') {
            const args = object(request.args);
            if (caller.role !== 'controller')
              throw new BridgeError(
                'POLICY_DENIED',
                'Only a controller may stop its Bridge runtime'
              );
            if (
              Object.keys(args).some((key) => key !== 'requestId') ||
              !id ||
              !/^[A-Za-z0-9_.:-]{1,128}$/.test(id)
            )
              throw new BridgeError('INVALID_ARGUMENT', 'runtime.stop requires a requestId');
            reply({
              apiVersion: 'agent-bridge/v1',
              operation,
              requestId: id,
              data: { stopping: true }
            });
            setImmediate(() => {
              void close().catch(() => {});
            });
            return;
          }
          const data = await app.dispatch(caller.id, operation, request.args);
          reply({
            apiVersion: 'agent-bridge/v1',
            operation,
            ...(id ? { requestId: id } : {}),
            data
          });
        } catch (error) {
          reply(errorReply(operation, error, id));
        }
      })();
    });
  });
  const close = (): Promise<void> => {
    closing ??= (async () => {
      try {
        await app.close();
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await unlink(target.socketPath).catch((error) => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        });
        await rmdir(target.socketDirectory).catch((error) => {
          if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
            throw error;
        });
        await releaseRuntime(target, binding);
        closeResolve();
      }
    })();
    return closing;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(target.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    await chmod(target.socketPath, 0o600);
    assertPrivate(await lstat(target.socketPath), 'socket');
  } catch (error) {
    await close();
    throw error;
  }
  return { socketPath: target.socketPath, close, closed };
}
