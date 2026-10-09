import type { EngineAdapter } from '../contracts/types.js';
import type { EngineId } from '../contracts/validation.js';
import { launchProcess } from './process.js';
import { probeEngine } from './probe.js';
import { launchCodexAppServer } from './app-server.js';

export function createAdapter(engine: EngineId): EngineAdapter {
  return {
    engine,
    probe: (config) => probeEngine(engine, config),
    launch: (input, observe) =>
      engine === 'codex' && input.config.codexTransport !== 'exec'
        ? launchCodexAppServer(input, observe)
        : launchProcess(engine, input, observe)
  };
}

export function createAdapters(): ReadonlyMap<EngineId, EngineAdapter> {
  return new Map(
    (['claude-code', 'zcode', 'codex'] as const).map((engine) => [engine, createAdapter(engine)])
  );
}
