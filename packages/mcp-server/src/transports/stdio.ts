import type { McpServer } from '../server.js';

export function startStdioServer(server: McpServer): void {
  process.stdin.setEncoding('utf8');
  let buffer = '';

  process.stdin.on('data', async (chunk) => {
    buffer += chunk;
    let lineBreak = buffer.indexOf('\n');

    while (lineBreak >= 0) {
      const line = buffer.slice(0, lineBreak).trim();
      buffer = buffer.slice(lineBreak + 1);
      lineBreak = buffer.indexOf('\n');

      if (!line) {
        continue;
      }

      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        process.stdout.write(
          `${JSON.stringify({
            id: 'unknown',
            error: {
              code: 'INVALID_PARAMS',
              message: 'Invalid JSON payload',
              traceId: 'stdio-parse'
            }
          })}\n`
        );
        continue;
      }

      const response = await server.handleRawRequest(raw);
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
}
