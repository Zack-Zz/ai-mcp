import type { SupportedProtocolVersion } from './types.js';

export const DEFAULT_PROTOCOL_VERSION: SupportedProtocolVersion = '2025-03-26';

export const NON_LEGACY_PROTOCOL_VERSIONS: readonly SupportedProtocolVersion[] = [
  '2025-11-25',
  '2025-03-26'
] as const;

export const LEGACY_PROTOCOL_VERSION: SupportedProtocolVersion = '2024-11-05';

export type ResolveProtocolVersionResult =
  | { ok: true; version: SupportedProtocolVersion }
  | { ok: false; statusCode: number; message: string };

export function resolveProtocolVersion(
  headerValue: string | undefined,
  options: { allowLegacyHttpSse: boolean }
): ResolveProtocolVersionResult {
  if (!headerValue) {
    return { ok: true, version: DEFAULT_PROTOCOL_VERSION };
  }

  if ((NON_LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(headerValue)) {
    return {
      ok: true,
      version: headerValue as SupportedProtocolVersion
    };
  }

  if (headerValue === LEGACY_PROTOCOL_VERSION) {
    if (!options.allowLegacyHttpSse) {
      return {
        ok: false,
        statusCode: 400,
        message: 'Legacy protocol 2024-11-05 is disabled by server policy'
      };
    }

    return {
      ok: true,
      version: LEGACY_PROTOCOL_VERSION
    };
  }

  return {
    ok: false,
    statusCode: 400,
    message: `Unsupported MCP-Protocol-Version: ${headerValue}`
  };
}
