import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

export type BodyReadResult =
  | { ok: true; body: Buffer }
  | { ok: false; status: number; message: string };

/** Bounds memory without destroying the socket before an HTTP error can be written. */
export function readBoundedHttpBody(
  req: IncomingMessage,
  maxBytes: number,
  signal?: AbortSignal
): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let finished = false;
    const finish = (result: BodyReadResult) => {
      if (finished) return;
      finished = true;
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      req.off('aborted', aborted);
      signal?.removeEventListener('abort', cancelled);
      chunks.length = 0;
      resolve(result);
    };
    const data = (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        finish({ ok: false, status: 413, message: `Request body exceeds ${maxBytes} bytes` });
        req.resume();
      } else chunks.push(chunk);
    };
    const end = () => finish({ ok: true, body: Buffer.concat(chunks) });
    const error = (cause: Error) => finish({ ok: false, status: 400, message: cause.message });
    const aborted = () => finish({ ok: false, status: 400, message: 'Request body aborted' });
    const cancelled = () => {
      finish({ ok: false, status: 404, message: 'Request body reading cancelled' });
      // Release listeners and buffered chunks without destroying the socket
      // before its owner can write the terminal HTTP response.
      req.resume();
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    req.once('aborted', aborted);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) cancelled();
    if (req.destroyed || req.aborted) aborted();
  });
}

type ListenerState = { sockets: Set<Socket>; closing?: Promise<void> };
const listeners = new WeakMap<Server, ListenerState>();

/** Register before listen() so even incomplete headers/body connections are owned. */
export function trackHttpListener(server: Server): void {
  if (listeners.has(server)) return;
  const state: ListenerState = { sockets: new Set() };
  listeners.set(server, state);
  server.on('connection', (socket) => {
    state.sockets.add(socket);
    socket.once('close', () => state.sockets.delete(socket));
  });
}

/** Stops admission immediately, then bounds the lifetime of remaining sockets. */
export function closeHttpListener(server: Server, graceMs: number): Promise<void> {
  trackHttpListener(server);
  const state = listeners.get(server)!;
  if (state.closing) return state.closing;
  state.closing = new Promise<void>((resolve) => {
    const timer = setTimeout(
      () => {
        for (const socket of state.sockets) socket.destroy();
      },
      Math.max(0, graceMs)
    );
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
  });
  return state.closing;
}
