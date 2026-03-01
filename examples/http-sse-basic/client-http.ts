import { createClient } from '@ai-mcp/mcp-client';

const client = createClient({
  transport: 'http',
  endpoint: 'http://localhost:3000/mcp'
});

const output = await client.callTool('time', {});
console.log(JSON.stringify({ output }, null, 2));
await client.close();
