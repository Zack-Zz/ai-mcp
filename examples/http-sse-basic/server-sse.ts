import { createServer } from '@ai-mcp/mcp-server';

const server = createServer();
server.startSse({ port: 3001, path: '/sse' });
console.log('sse server running at http://localhost:3001/sse');
