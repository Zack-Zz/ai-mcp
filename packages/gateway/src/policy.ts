import type { GatewayPolicyOptions, PolicyDecision, RequestContext } from './types.js';

const riskScore: Record<RequestContext['riskLevel'], number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3
};

function isRiskHigherThan(
  actual: RequestContext['riskLevel'],
  target: RequestContext['riskLevel']
) {
  return riskScore[actual] > riskScore[target];
}

function isRiskAtLeast(actual: RequestContext['riskLevel'], min: RequestContext['riskLevel']) {
  return riskScore[actual] >= riskScore[min];
}

export class GatewayPolicyEngine {
  private readonly allowTools: Set<string> | null;
  private readonly counters = new Map<string, { windowStart: number; count: number }>();

  public constructor(private readonly options: GatewayPolicyOptions = {}) {
    this.allowTools = options.allowTools ? new Set(options.allowTools) : null;
  }

  public filterVisibleTools(toolNames: string[]): string[] {
    if (this.allowTools === null) {
      return toolNames;
    }

    const allowTools = this.allowTools;
    return toolNames.filter((toolName) => allowTools.has(toolName));
  }

  public authorizeCall(ctx: RequestContext): PolicyDecision {
    if (this.allowTools && !this.allowTools.has(ctx.toolName)) {
      return {
        allowed: false,
        reason: `tool not allowed: ${ctx.toolName}`,
        reasonCode: 'ALLOWLIST'
      };
    }

    const denyLevels = this.options.riskPolicy?.denyLevels;
    if (denyLevels && denyLevels.includes(ctx.riskLevel)) {
      return {
        allowed: false,
        reason: `tool risk level denied: ${ctx.riskLevel}`,
        reasonCode: 'RISK_LEVEL'
      };
    }

    const maxAllowedLevel = this.options.riskPolicy?.maxAllowedLevel;
    if (maxAllowedLevel && isRiskHigherThan(ctx.riskLevel, maxAllowedLevel)) {
      return {
        allowed: false,
        reason: `tool risk level ${ctx.riskLevel} exceeds policy max ${maxAllowedLevel}`,
        reasonCode: 'RISK_LEVEL'
      };
    }

    for (const rule of this.options.conditionalAllow ?? []) {
      if (rule.toolName && rule.toolName !== ctx.toolName) {
        continue;
      }
      if (rule.minRiskLevel && !isRiskAtLeast(ctx.riskLevel, rule.minRiskLevel)) {
        continue;
      }

      if (rule.allowedTenants && !rule.allowedTenants.includes(ctx.tenantId)) {
        return {
          allowed: false,
          reason: `conditional allow denied for tenant ${ctx.tenantId}`,
          reasonCode: 'CONDITIONAL_ALLOW'
        };
      }

      if (rule.requiredTags && !rule.requiredTags.every((tag) => ctx.tags.includes(tag))) {
        return {
          allowed: false,
          reason: `conditional allow denied: missing required tags for ${ctx.toolName}`,
          reasonCode: 'CONDITIONAL_ALLOW'
        };
      }
    }

    if (!this.options.rateLimit) {
      return { allowed: true };
    }

    const key = `${ctx.tenantId}:${ctx.toolName}`;
    const existing = this.counters.get(key);

    if (!existing || ctx.now - existing.windowStart >= this.options.rateLimit.windowMs) {
      this.counters.set(key, { windowStart: ctx.now, count: 1 });
      return { allowed: true };
    }

    if (existing.count >= this.options.rateLimit.maxRequests) {
      return {
        allowed: false,
        reason: `rate limit exceeded for ${ctx.toolName}`,
        reasonCode: 'RATE_LIMIT'
      };
    }

    existing.count += 1;
    return { allowed: true };
  }
}
