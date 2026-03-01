import {
  promptSchemas,
  resourceSchemas,
  toolSchemas,
  type ToolInputMap,
  type ToolOutputMap
} from '@ai-mcp/shared';
import type { PromptDefinition, ResourceDefinition, ToolDefinition } from './types.js';

export const echoTool: ToolDefinition<ToolInputMap['echo'], ToolOutputMap['echo']> = {
  name: 'echo',
  description: 'Echo back the input payload',
  inputSchema: toolSchemas.echo.input,
  outputSchema: toolSchemas.echo.output,
  handler: async (input) => ({
    text: input.text,
    ...(input.metadata ? { metadata: input.metadata } : {})
  })
};

export const timeTool: ToolDefinition<ToolInputMap['time'], ToolOutputMap['time']> = {
  name: 'time',
  description: 'Get current ISO timestamp and timezone',
  inputSchema: toolSchemas.time.input,
  outputSchema: toolSchemas.time.output,
  handler: async (input) => {
    const timezone = input.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    return {
      iso: new Date().toISOString(),
      timezone
    };
  }
};

export const builtInTools = [echoTool, timeTool] as const;

export const serverInfoResource: ResourceDefinition<
  Record<string, never>,
  { name: string; version: string; transports: ('stdio' | 'http' | 'sse')[] }
> = {
  name: 'server-info',
  description: 'Return basic server metadata',
  paramsSchema: resourceSchemas['server-info'].params.unwrap(),
  outputSchema: resourceSchemas['server-info'].output,
  handler: async () => ({
    name: 'ai-mcp-server',
    version: '0.1.0',
    transports: ['stdio', 'http', 'sse']
  })
};

export const toolGuidePrompt: PromptDefinition<
  { toolName?: 'echo' | 'time' | undefined },
  { title: string; content: string }
> = {
  name: 'tool-guide',
  description: 'Generate a basic guide for built-in tools',
  argsSchema: promptSchemas['tool-guide'].args.unwrap(),
  outputSchema: promptSchemas['tool-guide'].output,
  handler: async (args) => {
    const name = args.toolName ?? 'echo';
    return {
      title: `Guide for ${name}`,
      content:
        name === 'time'
          ? 'Use time tool with optional timezone and receive ISO timestamp.'
          : 'Use echo tool with text and optional metadata to get the same payload back.'
    };
  }
};

export const builtInResources = [serverInfoResource] as const;
export const builtInPrompts = [toolGuidePrompt] as const;
