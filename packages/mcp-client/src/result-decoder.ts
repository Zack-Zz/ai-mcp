import { isJsonValue, type JsonObject, type NativeToolResult } from '@ai-mcp/shared';
import { McpClientError } from './errors.js';

type SdkCallToolResult = {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
  _meta?: unknown;
};

/**
 * Converts an SDK-parsed CallToolResult into the project's native semantic
 * result. The SDK already validated wire shapes; here we keep every content
 * block, the error flag and metadata without dropping media blocks.
 */
export function toNativeToolResult(raw: unknown): NativeToolResult {
  if (typeof raw !== 'object' || raw === null) {
    throw new McpClientError(
      'invalid_result',
      'INVALID_RESULT',
      'Downstream tool call returned a non-object result'
    );
  }
  const record = raw as SdkCallToolResult;
  if (!Array.isArray(record.content)) {
    throw new McpClientError(
      'invalid_result',
      'INVALID_RESULT',
      'Downstream tool call result has no content array'
    );
  }
  for (const block of record.content) {
    if (typeof block !== 'object' || block === null || Array.isArray(block)) {
      throw new McpClientError(
        'invalid_result',
        'INVALID_RESULT',
        'Downstream tool call result contains a malformed content block'
      );
    }
  }
  if (record.structuredContent !== undefined && !isJsonValue(record.structuredContent)) {
    throw new McpClientError(
      'invalid_result',
      'INVALID_RESULT',
      'Downstream tool call structuredContent is not a JSON value'
    );
  }

  return {
    content: record.content as JsonObject[],
    ...(record.structuredContent !== undefined
      ? { structuredContent: record.structuredContent }
      : {}),
    isError: record.isError === true,
    ...(record._meta !== undefined && isJsonValue(record._meta)
      ? { _meta: record._meta as JsonObject }
      : {})
  };
}

export function firstTextBlock(result: NativeToolResult): string | undefined {
  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return undefined;
}

/**
 * Legacy single-text JSON decode: used only as an explicit compatibility
 * fallback when no structuredContent exists. Returns undefined when the text
 * is not JSON; callers decide how to present that.
 */
export function decodeTextJsonFallback(result: NativeToolResult): unknown {
  const text = firstTextBlock(result);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

export function describeToolFailure(result: NativeToolResult, name: string): string {
  if (result.structuredContent !== undefined && typeof result.structuredContent === 'object') {
    const structured = result.structuredContent as JsonObject;
    const message = structured['message'] ?? structured['reason'];
    if (typeof message === 'string' && message.length > 0) {
      return `Tool ${name} failed: ${message}`;
    }
    return `Tool ${name} failed: ${JSON.stringify(result.structuredContent)}`;
  }
  const text = firstTextBlock(result);
  if (text !== undefined) {
    return `Tool ${name} failed: ${text}`;
  }
  return `Tool ${name} failed`;
}
