import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { BridgeError } from './errors.js';

export const API_VERSION = 'agent-bridge/v1' as const;
export const engineSchema = z.enum(['claude-code', 'zcode', 'codex']);
export type EngineId = z.infer<typeof engineSchema>;
const identity = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const text = z.string().min(1).max(32000);
export const relativeScope = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (value) =>
      !isAbsolute(value) &&
      !value.includes('\\') &&
      !value.includes('\0') &&
      !value.split('/').some((part) => part === '..' || part === '.git'),
    'Scope must remain inside the workspace'
  );
export const taskSpecSchema = z.strictObject({
  taskSpecVersion: z.literal('1'),
  objective: text,
  acceptanceCriteria: z.array(text).min(1).max(100),
  constraints: z.array(text).max(100).default([]),
  writeScope: z.array(relativeScope).min(1).max(200),
  contextRefs: z
    .array(z.strictObject({ path: z.string().min(1).max(4096), description: text.optional() }))
    .max(100)
    .default([]),
  scopeReference: z.string().min(1).max(1024),
  verificationIds: z.array(identity).max(20).default([]),
  limits: z
    .strictObject({
      timeoutMs: z.number().int().min(100).max(7200000).optional(),
      maxLogBytes: z.number().int().min(1024).max(67108864).optional()
    })
    .optional()
});
export type TaskSpec = z.infer<typeof taskSpecSchema>;
export const startSchema = z.strictObject({
  engine: engineSchema,
  projectId: identity,
  requestId: identity,
  taskSpec: taskSpecSchema,
  workspacePolicy: z.enum(['isolated', 'existing']).default('isolated'),
  sameEngineIntent: z.literal('independent-session').optional()
});
export type StartArgs = z.infer<typeof startSchema>;
const commandSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) => !/[;\n\r\0]/.test(value) && (isAbsolute(value) || /^[A-Za-z0-9_.-]+$/.test(value)),
    'Expected one executable, not shell code'
  );
export const engineConfigSchema = z.strictObject({
  command: commandSchema,
  args: z.array(z.string().max(4096)).max(100).default([]),
  env: z.record(z.string(), z.string()).default({}),
  pluginDirs: z.array(z.string().min(1)).default([]),
  codexTransport: z.enum(['app-server', 'exec']).optional()
});
export type EngineConfig = z.infer<typeof engineConfigSchema>;
const verificationSchema = z.strictObject({
  id: identity,
  command: commandSchema,
  args: z.array(z.string().max(4096)).max(100).default([]),
  timeoutMs: z.number().int().min(100).max(3600000).default(60000)
});
export const projectSchema = z.strictObject({
  id: identity,
  repoRoot: z.string().min(1).refine(isAbsolute),
  workingDirectory: z.string().default('.'),
  contextRoots: z.array(z.string().refine(isAbsolute)).default([]),
  permissionProfile: z.enum(['read-only', 'workspace-write']).default('workspace-write'),
  verifications: z.array(verificationSchema).max(100).default([])
});
export type ProjectConfig = z.infer<typeof projectSchema>;
export const clientSchema = z.strictObject({
  id: identity,
  role: z.enum(['controller', 'worker']),
  engine: engineSchema.optional(),
  sessionId: z.string().min(1).max(256).optional(),
  projectIds: z.array(identity).optional(),
  allowUnverified: z.boolean().default(false)
});
export type Caller = z.infer<typeof clientSchema>;
export const configSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stateRoot: z.string().min(1).refine(isAbsolute),
    projects: z.array(projectSchema).min(1),
    engines: z.partialRecord(engineSchema, engineConfigSchema),
    clients: z.array(clientSchema).min(1),
    defaultCallerRef: identity.default('terminal'),
    timeoutMs: z.number().int().min(100).max(7200000).default(1800000),
    maxLogBytes: z.number().int().min(1024).max(67108864).default(67108864)
  })
  .superRefine((value, ctx) => {
    for (const [name, entries] of [
      ['projects', value.projects],
      ['clients', value.clients]
    ] as const) {
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length)
        ctx.addIssue({ code: 'custom', message: `Duplicate ${name} identity`, path: [name] });
    }
    if (!Object.keys(value.engines).length)
      ctx.addIssue({ code: 'custom', message: 'No engines configured', path: ['engines'] });
    for (const [engine, config] of Object.entries(value.engines)) {
      if (engine !== 'codex' && config.codexTransport !== undefined)
        ctx.addIssue({
          code: 'custom',
          message: 'codexTransport applies only to Codex',
          path: ['engines', engine, 'codexTransport']
        });
    }
  })
  .transform((value) => ({
    ...value,
    engines: {
      ...value.engines,
      ...(value.engines.codex
        ? {
            codex: {
              ...value.engines.codex,
              codexTransport: value.engines.codex.codexTransport ?? 'app-server'
            }
          }
        : {})
    }
  }));
export type BridgeConfig = z.infer<typeof configSchema>;
export function parseStart(input: unknown): StartArgs {
  if (
    typeof input === 'object' &&
    input !== null &&
    (!('engine' in input) || input.engine === undefined)
  )
    throw new BridgeError('TARGET_REQUIRED', 'Select an explicit engine');
  const parsed = startSchema.safeParse(input);
  if (!parsed.success)
    throw new BridgeError(
      'INVALID_ARGUMENT',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  return parsed.data;
}
export function parseConfig(input: unknown): BridgeConfig {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success)
    throw new BridgeError(
      'INVALID_CONFIG',
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    );
  return parsed.data;
}
