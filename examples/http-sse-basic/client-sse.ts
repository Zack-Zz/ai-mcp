import { createClient } from '@ai-mcp/mcp-client';

const client = createClient({
  transport: 'sse',
  endpoint: 'http://localhost:3001/sse/call'
});

const output = await client.callTool('echo', { text: 'hello from sse transport' });
console.log(JSON.stringify({ output }, null, 2));
await client.close();
