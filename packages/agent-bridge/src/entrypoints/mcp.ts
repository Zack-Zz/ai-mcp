import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio, type ServeStdioOptions } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { startSchema, taskSpecSchema } from '../contracts/validation.js';
import { BridgeError } from '../contracts/errors.js';
import { errorReply, requestId } from '../client/protocol.js';
import type { OperationReply } from '../contracts/types.js';

export type BridgeMcpPort = { dispatch(operation: string, args: unknown): Promise<unknown> };
const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const taskId = z.string().regex(/^task_[0-9a-f-]{36}$/);
const get = z.strictObject({ taskId });
const outputSchema = z.strictObject({
  apiVersion: z.literal('agent-bridge/v1'),
  operation: z.string(),
  requestId: identity.optional(),
  data: z.unknown().optional(),
  error: z
    .strictObject({
      code: z.string(),
      message: z.string(),
      executionDisposition: z.enum(['not_started', 'completed', 'unknown']),
      details: z.record(z.string(), z.unknown()).optional()
    })
    .optional()
});
type Tool = {
  name: string;
  operation: string;
  description: string;
  inputSchema: z.ZodType<Record<string, unknown>>;
  readOnly: boolean;
};
const tools: Tool[] = [
  {
    name: 'agent_bridge_engines',
    operation: 'engine.list',
    description:
      'Read available engines and their actual capabilities. This does not dispatch a task.',
    inputSchema: z.strictObject({}),
    readOnly: true
  },
  {
    name: 'agent_bridge_preflight',
    operation: 'preflight',
    description:
      'Check the explicitly selected engine/project/scope; do not create a task or change caller identity.',
    inputSchema: startSchema
      .omit({ requestId: true })
      .extend({ taskSpec: taskSpecSchema.optional() }),
    readOnly: true
  },
  {
    name: 'agent_bridge_start',
    operation: 'task.start',
    description:
      'Start an explicitly delegated bounded task on the exact selected engine, with a stable request ID and independent session intent when required.',
    inputSchema: startSchema,
    readOnly: false
  },
  {
    name: 'agent_bridge_get',
    operation: 'task.get',
    description: 'Read the exact owned task. Never substitute the last or latest session.',
    inputSchema: get,
    readOnly: true
  },
  {
    name: 'agent_bridge_list',
    operation: 'task.list',
    description: 'List only tasks belonging to the already configured caller.',
    inputSchema: z.strictObject({
      limit: z.number().int().min(1).max(100).default(20),
      cursor: taskId.optional()
    }),
    readOnly: true
  },
  {
    name: 'agent_bridge_events',
    operation: 'task.watch',
    description:
      'Read owned task events after an exact cursor with bounded waiting. A connection closing does not cancel the runtime task.',
    inputSchema: get.extend({
      cursor: z
        .string()
        .regex(/^event_\d+$/)
        .optional(),
      waitMs: z.number().int().min(0).max(50000).default(0),
      limit: z.number().int().min(1).max(100).default(50)
    }),
    readOnly: true
  },
  {
    name: 'agent_bridge_continue',
    operation: 'task.continue',
    description:
      'Continue the exact owned session within its original task contract, with a stable write request ID. No --last or scope expansion.',
    inputSchema: get.extend({ requestId: identity, message: z.string().min(1).max(32000) }),
    readOnly: false
  },
  {
    name: 'agent_bridge_cancel',
    operation: 'task.cancel',
    description:
      'Request cancellation of the exact owned task; then read its actual terminal state.',
    inputSchema: get.extend({ requestId: identity }),
    readOnly: false
  },
  {
    name: 'agent_bridge_artifacts',
    operation: 'artifact.list',
    description:
      'List registered artifacts for the exact owned task, without arbitrary filesystem access.',
    inputSchema: get,
    readOnly: true
  },
  {
    name: 'agent_bridge_artifact_read',
    operation: 'artifact.read',
    description:
      'Read a registered owned artifact ID with bounded pagination; never accept an arbitrary file path.',
    inputSchema: get.extend({
      artifactId: z.string().min(1).max(128),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(65536).default(16384)
    }),
    readOnly: true
  }
];

export function createBridgeMcpServer(port: BridgeMcpPort): McpServer {
  const server = new McpServer(
    { name: 'agent-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema,
        annotations: {
          readOnlyHint: tool.readOnly,
          destructiveHint: !tool.readOnly,
          idempotentHint: true,
          openWorldHint: !tool.readOnly
        }
      },
      async (args) => {
        const id = requestId(args);
        let reply: OperationReply;
        try {
          const data = await port.dispatch(tool.operation, args);
          if (data === undefined)
            throw new BridgeError(
              'PROTOCOL_ERROR',
              'Bridge operation returned no JSON data',
              'unknown'
            );
          reply = {
            apiVersion: 'agent-bridge/v1',
            operation: tool.operation,
            ...(id ? { requestId: id } : {}),
            data
          };
          // Validate serializability here, so unexpected failures use the same masked DTO.
          JSON.stringify(reply);
        } catch (error) {
          reply = errorReply(tool.operation, error, id);
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(reply) }],
          structuredContent: reply,
          isError: !!reply.error
        };
      }
    );
  }
  return server;
}
export function serveBridgeStdio(
  port: BridgeMcpPort,
  options: Omit<ServeStdioOptions, 'legacy'> = {}
) {
  return serveStdio(() => createBridgeMcpServer(port), { ...options, legacy: 'reject' });
}
