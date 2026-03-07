import type {
  GatewayCapabilityOptions,
  GatewayTool,
  ToolCapabilityMetadata,
  ToolVisibility
} from './types.js';

const DEFAULT_TOOL_VISIBILITY: ToolVisibility = 'public';
const DEFAULT_TOOL_VERSION = '1.0.0';

function mergeStringArray(...inputs: Array<string[] | undefined>): string[] {
  const values = new Set<string>();
  for (const input of inputs) {
    if (!input) {
      continue;
    }
    for (const item of input) {
      values.add(item);
    }
  }
  return Array.from(values);
}

export class GatewayCapabilityRegistry {
  public constructor(private readonly options: GatewayCapabilityOptions = {}) {}

  public resolve(tool: GatewayTool): ToolCapabilityMetadata {
    const override = this.options.toolOverrides?.[tool.publicName];
    return {
      riskLevel:
        override?.riskLevel ??
        tool.metadata?.riskLevel ??
        this.options.defaultRiskLevel ??
        'medium',
      requiredPermissions: mergeStringArray(
        tool.metadata?.requiredPermissions,
        override?.requiredPermissions
      ),
      tags: mergeStringArray([tool.backendId], tool.metadata?.tags, override?.tags),
      version: override?.version ?? tool.metadata?.version ?? DEFAULT_TOOL_VERSION,
      visibility: override?.visibility ?? tool.metadata?.visibility ?? DEFAULT_TOOL_VISIBILITY
    };
  }

  public toDescription(baseDescription: string, metadata: ToolCapabilityMetadata): string {
    const suffix = [
      `risk=${metadata.riskLevel}`,
      `visibility=${metadata.visibility}`,
      `version=${metadata.version}`
    ];

    if (metadata.tags.length > 0) {
      suffix.push(`tags=${metadata.tags.join('|')}`);
    }

    if (metadata.requiredPermissions.length > 0) {
      suffix.push(`permissions=${metadata.requiredPermissions.join('|')}`);
    }

    return `${baseDescription} [${suffix.join('; ')}]`;
  }
}
