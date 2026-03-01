import { describe, expect, it } from 'vitest';
import {
  builtInPrompts,
  builtInResources,
  echoTool,
  timeTool,
  toolGuidePrompt
} from '../src/tools.js';

describe('built-in tools/resources/prompts', () => {
  it('echo tool returns input', async () => {
    const output = await echoTool.handler({ text: 'hello' }, { traceId: 'e1' });
    expect(output.text).toBe('hello');
  });

  it('time tool returns iso and timezone', async () => {
    const output = await timeTool.handler({}, { traceId: 't1' });
    expect(output.iso).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(output.timezone.length).toBeGreaterThan(0);
  });

  it('server info resource and prompt guide are available', async () => {
    expect(builtInResources.length).toBe(1);
    expect(builtInPrompts.length).toBe(1);

    const resourceOutput = await builtInResources[0].handler({}, { traceId: 'r1' });
    expect(resourceOutput.name).toBe('ai-mcp-server');

    const promptOutput = await toolGuidePrompt.handler({ toolName: 'time' }, { traceId: 'p1' });
    expect(promptOutput.title).toContain('time');
  });
});
