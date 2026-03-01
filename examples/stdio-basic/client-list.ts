import { createClient } from '@ai-mcp/mcp-client';

const client = createClient({
  transport: 'stdio',
  endpoint: 'node packages/mcp-server/dist/cli.js --transport stdio'
});

const tools = await client.listTools();
console.log(JSON.stringify({ tools }, null, 2));
await client.close();
