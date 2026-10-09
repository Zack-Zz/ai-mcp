import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { createMcpHandler } from '@modelcontextprotocol/server';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
  type NodeIncomingMessageLike
} from '@modelcontextprotocol/node';
import { createBridgeMcpServer, type BridgeMcpPort } from './mcp.js';
import { readPrivate } from '../client/security.js';
import { BridgeError } from '../contracts/errors.js';
import { MAX_FRAME_BYTES } from '../client/protocol.js';

export type BridgeHttpOptions = {
  port?: number;
  credential?: string;
  credentialFile?: string;
  maxRequestBodySize?: number;
  onerror?: (error: Error) => void;
};
async function localCredential(options: BridgeHttpOptions): Promise<Buffer> {
  if (!!options.credential === !!options.credentialFile)
    throw new BridgeError(
      'AUTH_REQUIRED',
      'Provide exactly one separate local HTTP credential source'
    );
  let token: unknown = options.credential;
  if (options.credentialFile) {
    let value: unknown;
    try {
      value = JSON.parse(await readPrivate(options.credentialFile));
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('AUTH_REQUIRED', 'HTTP credential must be readable private JSON');
    }
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => key !== 'token')
    )
      throw new BridgeError('AUTH_REQUIRED', 'HTTP credential file requires exactly a token');
    token = (value as { token?: unknown }).token;
  }
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw new BridgeError('AUTH_REQUIRED', 'HTTP credential must contain a 64-hex random token');
  return Buffer.from(token, 'hex');
}

/** A local protocol facade only. Closing it never closes/stops the external task runtime. */
export async function serveBridgeHttp(port: BridgeMcpPort, options: BridgeHttpOptions = {}) {
  const token = await localCredential(options);
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
  )
    throw new BridgeError('INVALID_ARGUMENT', 'HTTP port must be 0..65535');
  if (
    options.maxRequestBodySize !== undefined &&
    (!Number.isSafeInteger(options.maxRequestBodySize) ||
      options.maxRequestBodySize <= 0 ||
      options.maxRequestBodySize > MAX_FRAME_BYTES)
  )
    throw new BridgeError(
      'INVALID_ARGUMENT',
      'HTTP body limit must be positive and within the Bridge frame limit'
    );
  const handler = createMcpHandler(() => createBridgeMcpServer(port), {
    legacy: 'reject',
    ...(options.maxRequestBodySize ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
    ...(options.onerror ? { onerror: options.onerror } : {})
  });
  const node = toNodeHandler(handler, {
    ...(options.maxRequestBodySize ? { maxRequestBodySize: options.maxRequestBodySize } : {}),
    ...(options.onerror ? { onerror: options.onerror } : {})
  });
  const validateHost = localhostHostValidation();
  const validateOrigin = localhostOriginValidation();
  const server = createServer((request, response) => {
    if (!validateHost(request, response) || !validateOrigin(request, response)) return;
    if (request.url !== '/mcp') {
      response.writeHead(404);
      response.end();
      return;
    }
    if (!request.method) {
      response.writeHead(400);
      response.end();
      return;
    }
    const header = request.headers.authorization;
    const supplied =
      typeof header === 'string' && /^Bearer [a-f0-9]{64}$/.test(header)
        ? Buffer.from(header.slice(7), 'hex')
        : null;
    if (
      !supplied ||
      supplied.byteLength !== token.byteLength ||
      !timingSafeEqual(supplied, token)
    ) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store' });
      response.end();
      return;
    }
    // The SDK's public structural interface excludes explicit undefined optional fields.
    const incoming: NodeIncomingMessageLike = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      [Symbol.asyncIterator]: () => request[Symbol.asyncIterator]()
    };
    void node(incoming, response).catch((error) => {
      options.onerror?.(error instanceof Error ? error : new Error('HTTP protocol failure'));
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, '127.0.0.1', resolve);
    });
  } catch (error) {
    await handler.close();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP address');
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    close: () => {
      closing ??= (async () => {
        await handler.close();
        const stopped = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve()))
        );
        server.closeAllConnections();
        await stopped;
      })();
      return closing;
    }
  };
}
