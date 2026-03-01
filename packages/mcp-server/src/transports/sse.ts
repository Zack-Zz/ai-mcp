import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createTraceId } from '@ai-mcp/shared';
import type { McpServer, StartSseOptions } from '../server.js';

type Client = {
  id: number;
  response: ServerResponse;
};

let clientId = 0;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString('utf8');
  return body ? JSON.parse(body) : {};
}

function writeSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function startSseServer(server: McpServer, options: StartSseOptions) {
  const path = options.path ?? '/sse';
  const clients: Client[] = [];

  const httpServer = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === path) {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive'
      });
      res.write('\n');
      const client: Client = { id: ++clientId, response: res };
      clients.push(client);
      writeSse(res, 'connected', { clientId: client.id });

      req.on('close', () => {
        const index = clients.findIndex((entry) => entry.id === client.id);
        if (index >= 0) {
          clients.splice(index, 1);
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === `${path}/call`) {
      try {
        const payload = await readJson(req);
        const response = await server.handleRawRequest(payload);
        for (const client of clients) {
          writeSse(client.response, 'rpc-response', response);
        }
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
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  httpServer.listen(options.port);
  return httpServer;
}
