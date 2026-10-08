import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const log = process.argv[2];
const generation =
  readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"kind":"boot"')).length + 1;
const record = (kind, extra = {}) =>
  appendFileSync(log, `${JSON.stringify({ kind, generation, pid: process.pid, ...extra })}\n`);
record('boot');
const server = new Server(
  { name: 'stdio-lifecycle', version: '1' },
  { capabilities: { tools: {} } }
);
server.setRequestHandler(ListToolsRequestSchema, async () => {
  record('list');
  return {
    tools: [
      {
        name: 'probe',
        inputSchema: {
          type: 'object',
          properties: { generation: { const: generation }, exit: { type: 'boolean' } },
          required: ['generation']
        },
        _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
      }
    ]
  };
});
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  record('call');
  if (request.params.arguments?.exit) process.exit(0);
  return { content: [], structuredContent: { generation, pid: process.pid } };
});
await server.connect(new StdioServerTransport());
