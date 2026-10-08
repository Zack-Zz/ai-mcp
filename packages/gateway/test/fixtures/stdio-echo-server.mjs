// Minimal real MCP stdio server used by connector tests: echoes {q} back.
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

const server = new Server({ name: 'stdio-echo', version: '0.0.1' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: 'echo payload',
      inputSchema: {
        type: 'object',
        properties: { q: { type: 'string' } },
        required: ['q'],
        additionalProperties: false
      },
      _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const q = request.params?.arguments?.q;
  return {
    content: [{ type: 'text', text: JSON.stringify({ q }) }],
    structuredContent: { q },
    isError: false
  };
});

await server.connect(new StdioServerTransport());
