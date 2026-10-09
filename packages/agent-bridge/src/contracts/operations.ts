import type { z } from 'zod';
import type { EngineId, taskSpecSchema, startSchema } from './validation.js';
import type { Artifact, EngineProbe, TaskRecord, TaskState } from './types.js';

/** Callers may omit schema defaults; the service persists the normalized contract. */
export type TaskSpecInput = z.input<typeof taskSpecSchema>;
export type StartTaskArgs = z.input<typeof startSchema>;
export type TaskArgs = { taskId: string };
export type ContinueTaskArgs = TaskArgs & { requestId: string; message: string };
export type CancelTaskArgs = TaskArgs & { requestId: string };
export type ListTaskArgs = { limit?: number; cursor?: string };
export type WatchTaskArgs = TaskArgs & { cursor?: string; waitMs?: number; limit?: number };
export type PreflightArgs = {
  engine: EngineId;
  projectId: string;
  taskSpec?: TaskSpecInput;
  workspacePolicy?: 'isolated' | 'existing';
  sameEngineIntent?: 'independent-session';
};
export type EngineList = {
  engines: Array<
    EngineProbe | { engine: EngineId; available: false; version: null; reason: string }
  >;
  preferredTargets: EngineId[];
};
export type Preflight = {
  engine: EngineProbe;
  workspace: {
    repoRoot: string;
    workingDirectory: string;
    baselineRef: string;
    dirty: boolean;
    permissionProfile: string;
    scopeEnforcement: 'detect_only';
  };
  scopeChecked: boolean;
  authorizationEnforcement: 'instruction_and_config';
  independentSessionRequired: boolean;
};
export type TaskList = { tasks: TaskRecord[]; nextCursor: string | null };
export type TaskEvents = {
  events: Array<{
    cursor: string;
    timestamp: string;
    type: string;
    data: { taskId: string; state: TaskState; sessionId: string | null };
  }>;
  nextCursor: string;
  state: TaskState;
};
export type ArtifactList = { artifacts: Array<Omit<Artifact, 'path'>> };
export type ReadArtifactArgs = TaskArgs & { artifactId: string; offset?: number; limit?: number };
export type ArtifactPage = {
  artifactId: string;
  name: string;
  sha256: string;
  size: number;
  offset: number;
  bytesRead: number;
  nextOffset: number | null;
  truncated: boolean;
  encoding: 'base64';
  data: string;
  text: string;
};
