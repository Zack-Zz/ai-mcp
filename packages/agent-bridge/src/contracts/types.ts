import type { Caller, EngineConfig, EngineId, ProjectConfig, TaskSpec } from './validation.js';
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type CapabilityStatus = 'supported' | 'unsupported' | 'unverified';
export type EngineProbe = {
  engine: EngineId;
  available: boolean;
  version: string | null;
  capabilities: {
    newSession: CapabilityStatus;
    continueSession: CapabilityStatus;
    structuredEvents: CapabilityStatus;
    cancel: CapabilityStatus;
    readOnly: CapabilityStatus;
  };
  evidence?: string;
  reason?: string;
};
export type EngineEvent = {
  kind: 'session' | 'message' | 'usage' | 'diagnostic' | 'tool';
  data: JsonValue;
};
export type EngineOutcome = {
  status: 'completed' | 'failed' | 'cancelled';
  sessionId?: string;
  message: string;
  processGroupExited?: boolean;
  executionStopped?: boolean;
  exitCode: number | null;
  signal?: string | null;
  usage?: JsonValue;
  executionDisposition: 'completed' | 'unknown' | 'not_started';
};
export type LaunchInput = {
  runId: string;
  cwd: string;
  prompt: string;
  sessionId?: string;
  permissionProfile: ProjectConfig['permissionProfile'];
  config: EngineConfig;
  timeoutMs: number;
  maxLogBytes: number;
  signal?: AbortSignal;
};
export type EngineRunHandle = {
  pid: number | undefined;
  result: Promise<EngineOutcome>;
  interrupt(): Promise<void>;
};
export interface EngineAdapter {
  readonly engine: EngineId;
  probe(config: EngineConfig): Promise<EngineProbe>;
  launch(input: LaunchInput, observe: (event: EngineEvent) => void): Promise<EngineRunHandle>;
}
export type TaskState =
  | 'queued'
  | 'running'
  | 'cancel_requested'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'recovery_required';
export type RunRecord = {
  runId: string;
  state: TaskState;
  startedAt: string;
  finishedAt?: string;
  pid?: number;
  processStartIdentity?: string;
  /** Persisted before launch: recovery cannot substitute PID absence for complete stop proof. */
  terminationProofRequired?: boolean;
  outcome?: EngineOutcome;
  error?: { code: string; message: string };
};
export type VerificationRecord = {
  id: string;
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  signal?: string;
  durationMs: number;
};
export type Artifact = {
  artifactId: string;
  kind: 'diff' | 'manifest' | 'stdout' | 'stderr' | 'verification' | 'result';
  name: string;
  path: string;
  sha256: string;
  size: number;
};
export type Delivery = {
  deliveryId: string;
  runId: string;
  snapshotId: string;
  baselineSnapshotId: string;
  createdAt: string;
  scopeEnforcement: 'detect_only';
  outOfScope: string[];
  artifacts: Artifact[];
  verifications: VerificationRecord[];
};
export type TaskRecord = {
  taskId: string;
  engine: EngineId;
  projectId: string;
  owner: Caller;
  state: TaskState;
  requestId: string;
  spec: TaskSpec;
  sessionPolicy: 'new';
  sessionId?: string;
  permissionProfile: ProjectConfig['permissionProfile'];
  projectConfigHash: string;
  workspacePolicy: 'isolated' | 'existing';
  workspaceId: string;
  workspaceRoot: string;
  workingDirectory: string;
  repoRoot: string;
  baselineRef: string;
  baselineSnapshotId: string;
  createdAt: string;
  updatedAt: string;
  runs: RunRecord[];
  deliveries: Delivery[];
  attention?: { code: string; message: string };
};
export type EventRecord = {
  cursor: string;
  sequence: number;
  timestamp: string;
  taskId?: string;
  type: string;
  data: JsonValue;
};
export type OperationReply<T = unknown> = {
  apiVersion: 'agent-bridge/v1';
  operation: string;
  requestId?: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    executionDisposition: string;
    details?: Record<string, unknown>;
  };
};
