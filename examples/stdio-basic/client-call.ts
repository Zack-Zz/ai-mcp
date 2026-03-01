import { createClient } from '@ai-mcp/mcp-client';

const client = createClient({
  transport: 'stdio',
  endpoint: 'node packages/mcp-server/dist/cli.js --transport stdio'
});

const output = await client.callTool('echo', { text: 'hello from stdio' });
console.log(JSON.stringify({ output }, null, 2));
await client.close();
