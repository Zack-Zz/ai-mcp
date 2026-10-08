import type { InvocationContext } from '@ai-mcp/shared';

export function testInvocationContext(
  overrides: Partial<InvocationContext> = {}
): InvocationContext {
  return {
    invocationId: 'inv-test',
    traceId: 'trace-test',
    peerEra: 'legacy',
    protocolVersion: '2025-03-26',
    deadlineAt: Number.MAX_SAFE_INTEGER,
    signal: new AbortController().signal,
    actor: { tenantId: 'default' },
    ...overrides
  };
}
