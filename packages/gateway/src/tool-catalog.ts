import type { ToolCapabilityMetadata } from './types.js';
import { createHash } from 'node:crypto';
import {
  createStandardView,
  createStandardPassthroughView,
  isLegalToolName,
  DOWNSTREAM_TOOL_META_KEY,
  isJsonObject,
  RESULT_CONTRACT_META_KEY,
  SchemaCompiler,
  type CompiledSchema,
  type JsonObject,
  type ResolvedResultContract,
  type ResultContract,
  type ToolDescriptor
} from '@ai-mcp/shared';

export type CatalogErrorCode =
  | 'DUPLICATE_BACKEND'
  | 'DUPLICATE_PUBLIC_NAME'
  | 'RESULT_CONTRACT_AMBIGUOUS'
  | 'UNSUPPORTED_CAPABILITY'
  | 'INVALID_DESCRIPTOR';

export class CatalogError extends Error {
  public constructor(
    public readonly code: CatalogErrorCode,
    message: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = 'CatalogError';
  }
}

export type CatalogEntry = {
  metadata?: Partial<ToolCapabilityMetadata>;
  publicName: string;
  backendId: string;
  backendToolName: string;
  /** Original downstream descriptor, kept verbatim. */
  source: Readonly<ToolDescriptor>;
  /** Publicly advertised descriptor (renamed, wrapped output schema). */
  advertised: Readonly<ToolDescriptor>;
  /** 'legacy-auto' keeps the historical runtime envelope recognition. */
  contract: ResultContract;
  inputValidator: CompiledSchema;
  sourceOutputValidator?: CompiledSchema;
  publicOutputValidator: CompiledSchema;
  snapshotRevision: string;
};

export type GatewayCatalog = {
  revision: string;
  entries: readonly CatalogEntry[];
  findByPublicName(name: string): CatalogEntry | undefined;
};

export type CatalogBuildInput = {
  backends: ReadonlyArray<{
    id: string;
    resultContract?: ResultContract | undefined;
    tools: readonly ToolDescriptor[];
    metadataByName?: Readonly<Record<string, Partial<ToolCapabilityMetadata>>>;
  }>;
  options?: {
    toolOverrides?: Readonly<Record<string, ResolvedResultContract>> | undefined;
  };
};

/**
 * Registered legacy compatibility modes: the historical echo/time outputs
 * are the only payload shapes legacy-auto may treat as native under a
 * declared output schema. Anything else needs an explicit contract.
 */
const LEGACY_COMPAT_OUTPUT_SHAPES: ReadonlyArray<{
  backendToolName: string;
  requiredKeys: readonly string[];
}> = [
  { backendToolName: 'echo', requiredKeys: ['text'] },
  { backendToolName: 'time', requiredKeys: ['iso', 'timezone'] }
];

function isLegacyCompatOutput(descriptor: ToolDescriptor): boolean {
  return LEGACY_COMPAT_OUTPUT_SHAPES.some((mode) => {
    if (descriptor.name !== mode.backendToolName) {
      return false;
    }
    const output = descriptor.outputSchema;
    if (!isJsonObject(output)) {
      return false;
    }
    const required = output.required;
    if (!Array.isArray(required)) {
      return false;
    }
    return (
      required.length === mode.requiredKeys.length &&
      mode.requiredKeys.every((key) => required.includes(key))
    );
  });
}

function descriptorDeclaredContract(
  descriptor: ToolDescriptor
): ResolvedResultContract | undefined {
  const meta = descriptor._meta;
  if (!isJsonObject(meta)) {
    return undefined;
  }
  const declared = meta[RESULT_CONTRACT_META_KEY];
  if (declared === 'native-json/v1' || declared === 'standard/v1') {
    return declared;
  }
  return undefined;
}

function resolveContract(
  backendId: string,
  descriptor: ToolDescriptor,
  backendContract: ResultContract | undefined,
  toolOverrides: Readonly<Record<string, ResolvedResultContract>> | undefined,
  publicName: string
): ResultContract {
  if (toolOverrides?.[publicName]) {
    return toolOverrides[publicName];
  }
  // Design order: backend.resultContract outranks the descriptor's own
  // declaration so operators can override what a downstream claims.
  if (backendContract !== undefined && backendContract !== 'legacy-auto') return backendContract;
  const declared = descriptorDeclaredContract(descriptor);
  if (backendContract === undefined && declared) return declared;

  // legacy-auto: no output schema keeps the historical runtime recognition
  // of full StandardToolResult payloads; with a schema only the registered
  // compat shapes may default to native, everything else is ambiguous.
  if (descriptor.outputSchema === undefined) {
    return 'legacy-auto';
  }
  if (isLegacyCompatOutput(descriptor)) {
    return 'native-json/v1';
  }
  throw new CatalogError(
    'RESULT_CONTRACT_AMBIGUOUS',
    `Tool ${publicName} (backend ${backendId}) declares an output schema but no result contract; ` +
      `configure backend.resultContract or resultContracts.toolOverrides["${publicName}"]`,
    { publicName, backendId }
  );
}

function assertTaskSupport(publicName: string, descriptor: ToolDescriptor): void {
  const execution = descriptor.execution;
  if (!isJsonObject(execution)) {
    return;
  }
  const taskSupport = execution.taskSupport;
  if (taskSupport === 'required') {
    throw new CatalogError(
      'UNSUPPORTED_CAPABILITY',
      `Tool ${publicName} requires downstream task execution, which this gateway cannot proxy`,
      { publicName, taskSupport }
    );
  }
}

function buildAdvertised(
  publicName: string,
  source: ToolDescriptor,
  publicOutputSchema: JsonObject,
  descriptionSuffix: string,
  effectiveContract: ResultContract
): ToolDescriptor {
  const execution = isJsonObject(source.execution) ? { taskSupport: 'forbidden' } : undefined;
  const meta: JsonObject = { ...(source._meta ?? {}) };
  // The upstream consumes our standard envelope, regardless of the
  // downstream adaptation contract. Keep that decision in source metadata.
  const original: unknown = Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== undefined)
  );
  if (!isJsonObject(original))
    throw new CatalogError(
      'INVALID_DESCRIPTOR',
      `Tool ${publicName} descriptor is not JSON serializable`
    );
  meta[RESULT_CONTRACT_META_KEY] = 'standard/v1';
  // Its original metadata includes any previous gateway source descriptor.
  // Keep one provenance chain rather than duplicating it at every hop.
  meta[DOWNSTREAM_TOOL_META_KEY] = {
    resultContract: effectiveContract,
    descriptor: structuredClone(original)
  };
  return {
    name: publicName,
    description: `${source.description ?? ''}${descriptionSuffix}`,
    ...(source.title !== undefined ? { title: source.title } : {}),
    inputSchema: source.inputSchema,
    outputSchema: publicOutputSchema,
    ...(source.annotations !== undefined ? { annotations: source.annotations } : {}),
    ...(source.icons !== undefined ? { icons: source.icons } : {}),
    _meta: meta,
    ...(execution !== undefined ? { execution } : {})
  };
}

/**
 * Builds the frozen catalog: entries carry the source descriptor, compiled
 * validators for the downstream input/output schemas, and a public output
 * schema that describes the actually-wrapped standard envelope. Descriptor,
 * validators and routing keys all share one snapshot revision.
 */
export function buildCatalogEntries(input: CatalogBuildInput): GatewayCatalog {
  const compiler = new SchemaCompiler();
  const seenBackendIds = new Set<string>();
  const seenPublicNames = new Set<string>();
  const entries: CatalogEntry[] = [];

  for (const backend of input.backends) {
    if (!isLegalToolName(backend.id))
      throw new CatalogError('INVALID_DESCRIPTOR', `Invalid backend identity: ${backend.id}`, {
        backendId: backend.id
      });
    if (seenBackendIds.has(backend.id)) {
      throw new CatalogError('DUPLICATE_BACKEND', `Duplicate backend id: ${backend.id}`);
    }
    seenBackendIds.add(backend.id);

    for (const source of backend.tools) {
      const publicName = `${backend.id}__${source.name}`;
      if (!isLegalToolName(source.name) || !isLegalToolName(publicName)) {
        throw new CatalogError(
          'INVALID_DESCRIPTOR',
          `Invalid mapped tool name: ${publicName} (1-128 ASCII letters/digits/_/-/.)`,
          { backendId: backend.id, toolName: source.name, publicName }
        );
      }
      if (seenPublicNames.has(publicName)) {
        throw new CatalogError(
          'DUPLICATE_PUBLIC_NAME',
          `Duplicate mapped tool name: ${publicName}`
        );
      }
      seenPublicNames.add(publicName);

      if (source.inputSchema.type !== 'object')
        throw new CatalogError(
          'INVALID_DESCRIPTOR',
          `Tool ${publicName} inputSchema must have an object root`,
          { publicName }
        );
      let inputValidator: CompiledSchema;
      let sourceOutputValidator: CompiledSchema | undefined;
      try {
        inputValidator = compiler.compile(source.inputSchema);
        sourceOutputValidator = source.outputSchema
          ? compiler.compile(source.outputSchema)
          : undefined;
      } catch (error) {
        throw new CatalogError(
          'INVALID_DESCRIPTOR',
          `Tool ${publicName} advertises an unusable schema: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { publicName }
        );
      }

      assertTaskSupport(publicName, source);
      const contract = resolveContract(
        backend.id,
        source,
        backend.resultContract,
        input.options?.toolOverrides,
        publicName
      );

      // Native schemas describe payloads and need W(S). Standard schemas
      // already describe the complete envelope; only their dialect/resource
      // identities are normalized in the upstream view, not their body shape.
      let publicOutputSchema: JsonObject;
      let publicOutputValidator: CompiledSchema;
      try {
        publicOutputSchema =
          contract === 'standard/v1' && source.outputSchema
            ? createStandardPassthroughView(source.outputSchema)
            : contract === 'standard/v1' ||
                (contract === 'legacy-auto' && source.outputSchema === undefined)
              ? Object.fromEntries(
                  Object.entries(createStandardView()).filter(([key]) => key !== 'allOf')
                )
              : createStandardView(source.outputSchema);
        if (publicOutputSchema.type !== 'object')
          throw new Error('Public outputSchema must have an object root');
        publicOutputValidator = compiler.compile(publicOutputSchema);
      } catch (error) {
        throw new CatalogError(
          'INVALID_DESCRIPTOR',
          `Tool ${publicName} has an unusable public output schema: ${error instanceof Error ? error.message : String(error)}`,
          { publicName }
        );
      }

      entries.push({
        ...(backend.metadataByName?.[source.name]
          ? { metadata: backend.metadataByName[source.name] }
          : {}),
        publicName,
        backendId: backend.id,
        backendToolName: source.name,
        source,
        advertised: buildAdvertised(publicName, source, publicOutputSchema, '', contract),
        contract,
        inputValidator,
        ...(sourceOutputValidator !== undefined ? { sourceOutputValidator } : {}),
        publicOutputValidator,
        snapshotRevision: 'pending'
      });
    }
  }

  const revision = createHash('sha256')
    .update(
      JSON.stringify(
        entries.map((entry) => ({
          publicName: entry.publicName,
          backendId: entry.backendId,
          backendToolName: entry.backendToolName,
          input: entry.inputValidator.fingerprint,
          output: entry.publicOutputValidator.fingerprint,
          contract: entry.contract,
          metadata: entry.metadata
        }))
      )
    )
    .digest('hex')
    .slice(0, 16);

  const frozen = entries.map((entry) => ({ ...entry, snapshotRevision: revision }));
  const byName = new Map(frozen.map((entry) => [entry.publicName, entry]));
  return {
    revision,
    entries: frozen,
    findByPublicName: (name: string) => byName.get(name)
  };
}
