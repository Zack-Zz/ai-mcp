import { describe, expect, it } from 'vitest';
import { DEFAULT_PROTOCOL_VERSION, resolveProtocolVersion } from '../src/protocol.js';

describe('resolveProtocolVersion', () => {
  it('defaults to 2025-03-26 when header is missing', () => {
    const result = resolveProtocolVersion(undefined, { allowLegacyHttpSse: false });
    expect(result).toEqual({ ok: true, version: DEFAULT_PROTOCOL_VERSION });
  });

  it('accepts stable versions', () => {
    const v1 = resolveProtocolVersion('2025-11-25', { allowLegacyHttpSse: false });
    const v2 = resolveProtocolVersion('2025-03-26', { allowLegacyHttpSse: false });

    expect(v1).toEqual({ ok: true, version: '2025-11-25' });
    expect(v2).toEqual({ ok: true, version: '2025-03-26' });
  });

  it('rejects legacy version when compatibility mode is disabled', () => {
    const result = resolveProtocolVersion('2024-11-05', { allowLegacyHttpSse: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(400);
      expect(result.message).toContain('disabled');
    }
  });

  it('accepts legacy version when compatibility mode is enabled', () => {
    const result = resolveProtocolVersion('2024-11-05', { allowLegacyHttpSse: true });
    expect(result).toEqual({ ok: true, version: '2024-11-05' });
  });

  it('rejects unsupported versions', () => {
    const result = resolveProtocolVersion('9999-01-01', { allowLegacyHttpSse: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.statusCode).toBe(400);
      expect(result.message).toContain('Unsupported MCP-Protocol-Version');
    }
  });
});
