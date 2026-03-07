import { standardToolResultSchema, type StandardToolResult } from '@ai-mcp/shared';
import { DownstreamConnectorError, type ConnectorErrorCategory } from './base.js';

export function extractToolOutput(result: unknown): unknown {
  if (typeof result === 'object' && result !== null) {
    const maybeStructured = (result as { structuredContent?: unknown }).structuredContent;
    if (maybeStructured !== undefined) {
      return maybeStructured;
    }

    const maybeContent = (result as { content?: unknown }).content;
    if (Array.isArray(maybeContent)) {
      const textBlock = maybeContent.find(
        (item): item is { type: 'text'; text: string } =>
          typeof item === 'object' &&
          item !== null &&
          'type' in item &&
          item.type === 'text' &&
          'text' in item &&
          typeof item.text === 'string'
      );

      if (textBlock) {
        try {
          return JSON.parse(textBlock.text);
        } catch {
          return textBlock.text;
        }
      }
    }
  }

  throw new DownstreamConnectorError('invalid_result', 'Invalid downstream tool result');
}

export function toStandardToolResult(output: unknown): StandardToolResult {
  const parsed = standardToolResultSchema.safeParse(output);
  if (parsed.success) {
    return parsed.data;
  }

  return {
    ok: true,
    code: 'OK',
    message: 'Tool call succeeded',
    structuredContent: output
  };
}

export function normalizeConnectorError(error: unknown): DownstreamConnectorError {
  if (error instanceof DownstreamConnectorError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  let category: ConnectorErrorCategory = 'backend_error';

  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('abort')
  ) {
    category = 'backend_timeout';
  } else if (
    normalized.includes('connect') ||
    normalized.includes('fetch failed') ||
    normalized.includes('econnrefused') ||
    normalized.includes('not found')
  ) {
    category = 'backend_unavailable';
  } else if (normalized.includes('invalid') && normalized.includes('result')) {
    category = 'invalid_result';
  }

  return new DownstreamConnectorError(category, message, error);
}
