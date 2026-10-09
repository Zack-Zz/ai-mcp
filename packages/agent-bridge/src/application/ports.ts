import type { ProjectConfig, TaskSpec } from '../contracts/validation.js';
import type { TaskRecord, Delivery } from '../contracts/types.js';
import type { inspectWorkspace, prepareWorkspace } from '../workspaces/index.js';

type Inspection = Awaited<ReturnType<typeof inspectWorkspace>>;
type Binding = Awaited<ReturnType<typeof prepareWorkspace>>;
export type WorkspacePort = {
  inspect(
    project: ProjectConfig,
    policy: 'isolated' | 'existing',
    spec?: TaskSpec
  ): Promise<Inspection>;
  prepare(
    stateRoot: string,
    project: ProjectConfig,
    policy: 'isolated' | 'existing',
    taskId: string,
    spec: TaskSpec
  ): Promise<Binding>;
  capture(
    stateRoot: string,
    task: TaskRecord,
    runId: string,
    logs: { stdout: string; stderr: string; result: unknown; signal?: AbortSignal }
  ): Promise<Delivery>;
};
