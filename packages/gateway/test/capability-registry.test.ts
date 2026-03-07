import { describe, expect, it } from 'vitest';
import { GatewayCapabilityRegistry } from '../src/capability-registry.js';

describe('GatewayCapabilityRegistry', () => {
  it('resolves default metadata and backend tag', () => {
    const registry = new GatewayCapabilityRegistry();

    const metadata = registry.resolve({
      publicName: 'a__echo',
      backendId: 'a',
      backendToolName: 'echo',
      description: 'Echo'
    });

    expect(metadata.riskLevel).toBe('medium');
    expect(metadata.tags).toContain('a');
    expect(metadata.visibility).toBe('public');
  });

  it('applies tool-level overrides', () => {
    const registry = new GatewayCapabilityRegistry({
      defaultRiskLevel: 'low',
      toolOverrides: {
        a__echo: {
          riskLevel: 'high',
          requiredPermissions: ['repo:write'],
          tags: ['critical-path'],
          visibility: 'internal',
          version: '2.1.0'
        }
      }
    });

    const metadata = registry.resolve({
      publicName: 'a__echo',
      backendId: 'a',
      backendToolName: 'echo',
      description: 'Echo'
    });

    expect(metadata.riskLevel).toBe('high');
    expect(metadata.requiredPermissions).toEqual(['repo:write']);
    expect(metadata.tags).toEqual(expect.arrayContaining(['a', 'critical-path']));
    expect(metadata.visibility).toBe('internal');
    expect(metadata.version).toBe('2.1.0');
  });
});
