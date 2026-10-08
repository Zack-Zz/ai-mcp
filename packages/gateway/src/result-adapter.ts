import {
  isJsonObject,
  standardToolResultEnvelopeSchema,
  type InvocationFault,
  type NativeToolResult,
  type StandardToolResult
} from '@ai-mcp/shared';
import type { CatalogEntry } from './tool-catalog.js';

export type AdaptedResult =
  | { kind: 'success'; standard: StandardToolResult }
  | { kind: 'tool_failure'; standard: StandardToolResult; fault: InvocationFault }
  | { kind: 'failure'; fault: InvocationFault };

function firstText(result: NativeToolResult): string | undefined {
  for (const block of result.content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text;
    }
  }
  return undefined;
}

function decodeTextFallback(result: NativeToolResult): unknown {
  const text = firstText(result);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function baseFault(
  entry: CatalogEntry,
  category: InvocationFault['category'],
  projectCode: string,
  message: string
): InvocationFault {
  return {
    category,
    projectCode,
    message,
    traceId: 'unassigned',
    invocationId: 'unassigned',
    executionDisposition: 'completed',
    source: { kind: 'peer', backendId: entry.backendId }
  };
}

function describeNativeError(result: NativeToolResult): string {
  const structured = result.structuredContent;
  if (isJsonObject(structured) && typeof structured.message === 'string') {
    return structured.message;
  }
  const text = firstText(result);
  if (text !== undefined) {
    return text;
  }
  if (structured !== undefined) {
    return JSON.stringify(structured);
  }
  return 'Downstream tool call failed';
}

/**
 * Result adaptation follows the fixed order: native isError first, then the
 * frozen per-tool contract. Business payloads containing ok:false under a
 * native contract stay successful data; only native isError or an explicit
 * standard/v1 ok:false becomes a tool failure.
 */
export type ResultIdentity = {
  traceId: string;
  invocationId: string;
  runId?: string;
  taskId?: string;
};

/**
 * Envelope-level context enrichment (kept from the historical contract):
 * trace/run/task ride on the standard envelope fields when the downstream
 * did not provide them; business payload bodies are never modified.
 */
function withIdentity(standard: StandardToolResult, identity: ResultIdentity): StandardToolResult {
  return {
    ...standard,
    ...(standard.traceId === undefined ? { traceId: identity.traceId } : {}),
    ...(standard.runId === undefined && identity.runId !== undefined
      ? { runId: identity.runId }
      : {}),
    ...(standard.taskId === undefined && identity.taskId !== undefined
      ? { taskId: identity.taskId }
      : {})
  };
}

export function adaptDownstreamResult(
  native: NativeToolResult,
  entry: CatalogEntry,
  identity: ResultIdentity = { traceId: 'unassigned', invocationId: 'unassigned' }
): AdaptedResult {
  const stamp = (fault: InvocationFault): InvocationFault => ({
    ...fault,
    traceId: identity.traceId,
    invocationId: identity.invocationId
  });

  const payload =
    native.structuredContent !== undefined ? native.structuredContent : decodeTextFallback(native);
  const parsedStandard =
    entry.contract === 'standard/v1' || entry.contract === 'legacy-auto'
      ? standardToolResultEnvelopeSchema.safeParse(payload)
      : null;
  const enrich = (envelope: StandardToolResult): StandardToolResult => {
    const candidate = withIdentity(envelope, identity);
    // A closed downstream standard schema describes the whole envelope.
    // Keep its body intact when context fields are forbidden; the gateway
    // publishes correlation separately in result _meta.
    return entry.contract === 'standard/v1' &&
      entry.sourceOutputValidator &&
      !entry.sourceOutputValidator.validate(candidate).valid
      ? envelope
      : candidate;
  };

  // Native failures win over claims of success, while valid standard
  // failure envelopes keep their original business code and diagnostics.
  if (native.isError) {
    const message = describeNativeError(native);
    const standard: StandardToolResult =
      parsedStandard?.success && !parsedStandard.data.ok
        ? enrich(parsedStandard.data)
        : withIdentity(
            {
              ok: false,
              code: 'TOOL_FAILED',
              message,
              ...(native.structuredContent !== undefined
                ? { structuredContent: native.structuredContent }
                : {}),
              ...(native.content.length ? { content: native.content } : {})
            },
            identity
          );
    return {
      kind: 'tool_failure',
      standard,
      fault: stamp(baseFault(entry, 'tool_failure', standard.code, message))
    };
  }

  if (entry.contract === 'standard/v1') {
    if (!parsedStandard?.success) {
      return {
        kind: 'failure',
        fault: stamp(
          baseFault(
            entry,
            'invalid_result',
            'INVALID_RESULT',
            `Tool ${entry.publicName} declared standard/v1 but returned a non-standard payload`
          )
        )
      };
    }
    const envelope = parsedStandard.data;
    if (!envelope.ok) {
      return {
        kind: 'tool_failure',
        standard: enrich(envelope),
        fault: stamp(
          baseFault(
            entry,
            'tool_failure',
            envelope.code,
            envelope.message || 'Downstream tool call failed'
          )
        )
      };
    }
    if (entry.sourceOutputValidator && !entry.sourceOutputValidator.validate(payload).valid) {
      return {
        kind: 'failure',
        fault: stamp(
          baseFault(
            entry,
            'invalid_result',
            'INVALID_RESULT',
            `Tool ${entry.publicName} standard success envelope violates its declared schema`
          )
        )
      };
    }
    return { kind: 'success', standard: enrich(envelope) };
  }

  // 3. native-json/v1 with a declared schema: validate the payload.
  if (entry.contract === 'native-json/v1' && entry.sourceOutputValidator) {
    if (payload === undefined) {
      return {
        kind: 'failure',
        fault: stamp(
          baseFault(
            entry,
            'invalid_result',
            'INVALID_RESULT',
            `Tool ${entry.publicName} declared an output schema but returned no structuredContent`
          )
        )
      };
    }
    const check = entry.sourceOutputValidator.validate(payload);
    if (!check.valid) {
      return {
        kind: 'failure',
        fault: stamp(
          baseFault(
            entry,
            'invalid_result',
            'INVALID_RESULT',
            `Tool ${entry.publicName} success payload violates its declared output schema`
          )
        )
      };
    }
  }

  // 4. legacy-auto (or native without a schema): recognize full standard
  // envelopes from the historical behavior, otherwise wrap the payload.
  if (entry.contract === 'legacy-auto' && isJsonObject(payload)) {
    const parsed = standardToolResultEnvelopeSchema.safeParse(payload);
    if (parsed.success) {
      if (parsed.data.ok) {
        return { kind: 'success', standard: withIdentity(parsed.data, identity) };
      }
      return {
        kind: 'tool_failure',
        standard: parsed.data,
        fault: stamp(
          baseFault(
            entry,
            'tool_failure',
            'TOOL_FAILED',
            parsed.data.message || 'Downstream tool call failed'
          )
        )
      };
    }
  }

  if (payload === undefined && native.content.length === 0) {
    return {
      kind: 'failure',
      fault: stamp(
        baseFault(
          entry,
          'invalid_result',
          'INVALID_RESULT',
          `Tool ${entry.publicName} returned neither structured content nor decodable text`
        )
      )
    };
  }

  return {
    kind: 'success',
    standard: withIdentity(
      {
        ok: true,
        code: 'OK',
        message: 'Tool call succeeded',
        ...(payload !== undefined ? { structuredContent: payload } : {}),
        ...(native.content.length > 0 ? { content: native.content as unknown[] } : {})
      },
      identity
    )
  };
}
