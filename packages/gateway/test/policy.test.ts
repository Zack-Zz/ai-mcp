import { describe, expect, it } from 'vitest';
import { GatewayPolicyEngine } from '../src/policy.js';

describe('GatewayPolicyEngine', () => {
  it('filters tools by allowlist', () => {
    const engine = new GatewayPolicyEngine({
      allowTools: ['a__echo']
    });

    const visible = engine.filterVisibleTools(['a__echo', 'b__time']);
    expect(visible).toEqual(['a__echo']);
  });

  it('denies call for non-allowlisted tool', () => {
    const engine = new GatewayPolicyEngine({
      allowTools: ['a__echo']
    });

    const decision = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'b__time',
      traceId: 'trace-1',
      now: 1000
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('tool not allowed');
  });

  it('enforces per-tenant per-tool fixed-window rate limit', () => {
    const engine = new GatewayPolicyEngine({
      rateLimit: {
        windowMs: 1000,
        maxRequests: 2
      }
    });

    const first = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-1',
      now: 1000
    });
    const second = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-2',
      now: 1100
    });
    const third = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-3',
      now: 1200
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
  });

  it('resets counter when window has passed', () => {
    const engine = new GatewayPolicyEngine({
      rateLimit: {
        windowMs: 1000,
        maxRequests: 1
      }
    });

    const first = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-1',
      now: 1000
    });
    const second = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-2',
      now: 2500
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });
});
