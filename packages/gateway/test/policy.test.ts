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
      now: 1000,
      riskLevel: 'low',
      tags: [],
      requiredPermissions: []
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('tool not allowed');
    expect(decision.reasonCode).toBe('ALLOWLIST');
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
      now: 1000,
      riskLevel: 'low',
      tags: [],
      requiredPermissions: []
    });
    const second = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-2',
      now: 1100,
      riskLevel: 'low',
      tags: [],
      requiredPermissions: []
    });
    const third = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-3',
      now: 1200,
      riskLevel: 'low',
      tags: [],
      requiredPermissions: []
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.reasonCode).toBe('RATE_LIMIT');
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
      now: 1000,
      riskLevel: 'low',
      tags: [],
      requiredPermissions: []
    });
    const second = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-2',
      now: 2500,
      riskLevel: 'low',
      tags: [],
      requiredPermissions: []
    });

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
  });

  it('denies call when tool risk exceeds max allowed level', () => {
    const engine = new GatewayPolicyEngine({
      riskPolicy: {
        maxAllowedLevel: 'medium'
      }
    });

    const decision = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-1',
      now: 1000,
      riskLevel: 'high',
      tags: [],
      requiredPermissions: []
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe('RISK_LEVEL');
  });

  it('enforces conditional allow tenant scoping for high-risk tools', () => {
    const engine = new GatewayPolicyEngine({
      conditionalAllow: [
        {
          minRiskLevel: 'high',
          allowedTenants: ['core-platform']
        }
      ]
    });

    const denied = engine.authorizeCall({
      tenantId: 't1',
      toolName: 'a__echo',
      traceId: 'trace-1',
      now: 1000,
      riskLevel: 'high',
      tags: [],
      requiredPermissions: []
    });

    const allowed = engine.authorizeCall({
      tenantId: 'core-platform',
      toolName: 'a__echo',
      traceId: 'trace-2',
      now: 1001,
      riskLevel: 'high',
      tags: [],
      requiredPermissions: []
    });

    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe('CONDITIONAL_ALLOW');
    expect(allowed.allowed).toBe(true);
  });
});
