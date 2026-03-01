import type { GatewayPolicyOptions, PolicyDecision, RequestContext } from './types.js';

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
        reason: `tool not allowed: ${ctx.toolName}`
      };
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
        reason: `rate limit exceeded for ${ctx.toolName}`
      };
    }

    existing.count += 1;
    return { allowed: true };
  }
}
