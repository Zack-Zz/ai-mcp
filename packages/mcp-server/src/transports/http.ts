import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createTraceId } from '@ai-mcp/shared';
import type { McpServer, StartHttpOptions } from '../server.js';

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

export function startHttpServer(server: McpServer, options: StartHttpOptions) {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
      return;
    }

    try {
      const payload = await readJson(req);
      const response = await server.handleRawRequest(payload);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    } catch (error) {
      const traceId = createTraceId();
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'unknown',
          error: {
            code: 'INVALID_PARAMS',
            message: error instanceof Error ? error.message : String(error),
            traceId
          }
        })
      );
    }
  });

  httpServer.listen(options.port);
  return httpServer;
}
