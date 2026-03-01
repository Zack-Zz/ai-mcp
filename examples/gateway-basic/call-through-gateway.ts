import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.env.GATEWAY_ENDPOINT ?? 'http://localhost:4100/mcp';

const client = new Client({
  name: 'gateway-basic-example-client',
  version: '0.1.0'
});

await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

const tools = await client.listTools();
console.log(
  'tools:',
  tools.tools.map((tool) => tool.name)
);

const output = await client.callTool({
  name: 'local__echo',
  arguments: { text: 'hello via gateway' }
});

console.log('output:', output.structuredContent ?? output.content);

await client.close();
