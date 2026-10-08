// Downstream MCP server for e2e verification. Exposes custom business tools
// beyond echo/time so the gateway path proves generic registration, schema
// flow, error semantics and real handler overlap across two callers.
import { Server } from '../../packages/gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js';
import { StdioServerTransport } from '../../packages/gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '../../packages/gateway/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js';

const server = new Server({ name: 'e2e-custom-tools', version: '0.0.1' }, {
  capabilities: { tools: {} }
});

// In-process barrier proving two gateway calls overlap inside one handler.
let barrierEntered = 0;
let barrierRelease;
const barrierReleased = new Promise((resolve) => {
  barrierRelease = resolve;
});

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'catalog.lookup',
      description: 'Look up catalog items',
      inputSchema: {
        type: 'object',
        properties: {
          sku: { type: 'string', minLength: 3 },
          region: { enum: ['cn', 'eu'] }
        },
        required: ['sku'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { sku: { type: 'string' }, region: { type: 'string' } },
        required: ['sku', 'region'],
        additionalProperties: false
      },
      _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
    },
    {
      name: 'warehouse.reserve',
      description: 'Reserve stock (fails with structured diagnostics)',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
    },
    {
      name: 'tasks.get',
      description: 'Query a task that has failed (the query itself succeeds)',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { task: { type: 'object' } },
        required: ['task']
      },
      _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
    },
    {
      name: 'report.status',
      description: 'Standard/v1 downstream result',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      outputSchema: {
        type: 'object',
        properties: { done: { type: 'boolean' } },
        required: ['done']
      },
      _meta: { 'org.ai-mcp/result-contract': 'standard/v1' }
    },
    {
      name: 'probe.overlap',
      description: 'Barrier tool proving concurrent handler execution',
      inputSchema: {
        type: 'object',
        properties: { marker: { type: 'string' } },
        required: ['marker'],
        additionalProperties: false
      },
      outputSchema: {
        type: 'object',
        properties: { marker: { type: 'string' } },
        required: ['marker'],
        additionalProperties: false
      },
      _meta: { 'org.ai-mcp/result-contract': 'native-json/v1' }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name ?? '';
  const args = request.params?.arguments ?? {};
  const meta = request.params?._meta?.['org.ai-mcp/context'];

  switch (name) {
    case 'catalog.lookup': {
      const region = args.region ?? 'cn';
      return {
        content: [{ type: 'text', text: JSON.stringify({ sku: args.sku, region }) }],
        structuredContent: { sku: args.sku, region },
        isError: false,
        _meta: meta ? { 'org.ai-mcp/context': { traceId: meta.traceId } } : undefined
      };
    }
    case 'warehouse.reserve': {
      // Native isError with structured data that violates any success schema.
      return {
        content: [{ type: 'text', text: 'warehouse offline' }],
        structuredContent: { reason: 'out_of_stock', retryable: false },
        isError: true
      };
    }
    case 'tasks.get': {
      return {
        content: [{ type: 'text', text: 'task' }],
        structuredContent: { task: { id: args.id, state: 'failed' } },
        isError: false
      };
    }
    case 'report.status': {
      return {
        content: [{ type: 'text', text: 'report' }],
        structuredContent: { ok: false, code: 'REPORT_REJECTED', message: 'window closed' },
        isError: false
      };
    }
    case 'probe.overlap': {
      barrierEntered += 1;
      if (barrierEntered >= 2) {
        barrierRelease();
      }
      await barrierReleased;
      return {
        content: [{ type: 'text', text: JSON.stringify({ marker: args.marker }) }],
        structuredContent: { marker: args.marker },
        isError: false
      };
    }
    default:
      return {
        content: [{ type: 'text', text: `unknown tool: ${name}` }],
        isError: true
      };
  }
});

await server.connect(new StdioServerTransport());
