import type { EngineConfig } from '../contracts/validation.js';

export function nativeEnvironment(config: EngineConfig): NodeJS.ProcessEnv {
  // Provider credentials may be inherited; the originating session/control plane may not.
  return Object.fromEntries(
    Object.entries({ ...process.env, ...config.env }).filter(
      ([key]) =>
        !/^AGENT_BRIDGE_/i.test(key) &&
        !/^CODEX_(SANDBOX(?:_.*)?|THREAD_ID|SESSION_ID|APP_TOOLS_PIPE_PATH|TASK_WORKSPACE_VERIFYING_IDENTITY|SAGE_BACKFILL_TRACKER_TAB_REUSE)$/i.test(
          key
        )
    )
  );
}
