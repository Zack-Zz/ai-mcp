import {
  isJsonObject,
  standardToolResultEnvelopeSchema,
  type NativeToolResult,
  type ResultContract,
  type ToolDescriptor,
  type StandardToolResult
} from '@ai-mcp/shared';
import { McpClientError } from '@ai-mcp/mcp-client';
import { DownstreamConnectorError, type ConnectorErrorCategory } from './base.js';

export function firstTextBlock(result: NativeToolResult): string | undefined {
  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return undefined;
}

/**
 * Legacy compatibility projection onto StandardToolResult. Native error
 * results are never reported as ok:true here; contract-aware unwrapping for
 * standard/v1 backends happens in the gateway result adapter.
 */
export function descriptorResultContract(descriptor: ToolDescriptor): ResultContract {
  const declared = descriptor._meta?.['org.ai-mcp/result-contract'];
  return declared === 'native-json/v1' || declared === 'standard/v1' || declared === 'legacy-auto'
    ? declared
    : 'legacy-auto';
}

export function projectStandardResult(
  native: NativeToolResult,
  contract: ResultContract = 'legacy-auto'
): StandardToolResult {
  const payload =
    native.structuredContent !== undefined
      ? native.structuredContent
      : decodeTextJsonFallback(native);
  const parsed =
    contract !== 'native-json/v1' ? standardToolResultEnvelopeSchema.safeParse(payload) : undefined;
  if (native.isError) {
    if (parsed?.success && !parsed.data.ok) return parsed.data;
    const structured = native.structuredContent;
    const messageFromStructured =
      isJsonObject(structured) && typeof structured.message === 'string'
        ? structured.message
        : undefined;
    const message =
      messageFromStructured ?? firstTextBlock(native) ?? 'Downstream tool call failed';
    return {
      ok: false,
      code: 'TOOL_FAILED',
      message,
      ...(structured !== undefined ? { structuredContent: structured } : {}),
      content: native.content as unknown[]
    };
  }

  if (payload === undefined && native.content.length === 0) {
    throw new DownstreamConnectorError(
      'invalid_result',
      'Downstream returned neither structured content nor text content'
    );
  }

  if (parsed?.success) {
    return parsed.data;
  }
  if (contract === 'standard/v1')
    throw new DownstreamConnectorError(
      'invalid_result',
      'Downstream returned an invalid standard envelope'
    );
  return {
    ok: true,
    code: 'OK',
    message: 'Tool call succeeded',
    ...(payload !== undefined ? { structuredContent: payload } : {}),
    ...(native.content.length ? { content: native.content } : {})
  };
}

function decodeTextJsonFallback(result: NativeToolResult): unknown {
  const text = firstTextBlock(result);
  if (text === undefined) {
    return undefined;
  }
  // Legacy decode: JSON text becomes structured data; plain text stays a
  // string payload. Content-only results are not schema-validated here.
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

export function toConnectorError(error: unknown): DownstreamConnectorError {
  if (error instanceof DownstreamConnectorError) {
    return error;
  }
  if (error instanceof McpClientError) {
    return new DownstreamConnectorError(
      connectorCategory(error.category),
      error.message,
      error.details,
      error.permanent
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new DownstreamConnectorError('backend_error', message, error);
}

function connectorCategory(category: string): ConnectorErrorCategory {
  switch (category) {
    case 'backend_timeout':
    case 'backend_unavailable':
    case 'invalid_result':
    case 'invalid_request':
    case 'invalid_params':
    case 'cancelled':
    case 'rate_limited':
    case 'policy_denied':
      return category === 'invalid_params' ? 'invalid_request' : category;
    default:
      return 'backend_error';
  }
}
