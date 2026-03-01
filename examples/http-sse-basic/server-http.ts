import { createServer } from '@ai-mcp/mcp-server';

const server = createServer();
server.startHttp({ port: 3000 });
console.log('http server running at http://localhost:3000/mcp');
