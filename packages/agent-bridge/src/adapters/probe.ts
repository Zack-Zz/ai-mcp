import { spawn } from 'node:child_process';
import type { CapabilityStatus, EngineProbe } from '../contracts/types.js';
import type { EngineConfig, EngineId } from '../contracts/validation.js';
import { scrubText } from './events.js';
import { validateConfig } from './native.js';
import { nativeEnvironment } from './environment.js';

export async function inspect(config: EngineConfig, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(config.command, [...config.args, ...args], {
      env: nativeEnvironment(config),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let text = '';
    let invalid = false;
    const timer = setTimeout(() => {
      invalid = true;
      child.kill('SIGKILL');
    }, 3000);
    const capture = (data: Buffer) => {
      if (text.length + data.length > 128000) {
        invalid = true;
        child.kill('SIGKILL');
      } else text += data.toString('utf8');
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    child.once('error', () => {
      invalid = true;
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 && !invalid ? text.trim() : null);
    });
  });
}
export async function probeEngine(engine: EngineId, config: EngineConfig): Promise<EngineProbe> {
  const unknown = {
    newSession: 'unverified',
    continueSession: 'unverified',
    structuredEvents: 'unverified',
    cancel: 'unverified',
    readOnly: 'unverified'
  } as const;
  try {
    validateConfig(engine, config);
  } catch {
    return {
      engine,
      available: false,
      version: null,
      capabilities: unknown,
      reason: 'Unsupported engine launcher configuration'
    };
  }
  const appServer = engine === 'codex' && config.codexTransport !== 'exec';
  const version = await inspect(config, ['--version']);
  const help = await inspect(
    config,
    engine === 'codex' ? [appServer ? 'app-server' : 'exec', '--help'] : ['--help']
  );
  if (!version || !help)
    return {
      engine,
      available: false,
      version: null,
      capabilities: unknown,
      reason: 'Native executable help/version probe failed'
    };
  const capability = (present: boolean): CapabilityStatus =>
    present ? 'supported' : 'unsupported';
  const appServerInterface = !!appServer && help.includes('--listen') && help.includes('stdio');
  const secrets = Object.entries({ ...process.env, ...config.env })
    .filter(([key]) => /key|token|password|secret/i.test(key))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string');
  return {
    engine,
    available: true,
    version: scrubText(
      version
        .split('\n')
        .filter((line) => !line.startsWith('WARNING:'))
        .at(-1) ?? '',
      secrets
    ),
    evidence: 'interface-only',
    capabilities: {
      newSession: capability(
        appServer
          ? appServerInterface
          : help.includes(
              engine === 'claude-code' ? '--session-id' : engine === 'zcode' ? '--prompt' : 'exec'
            )
      ),
      continueSession: capability(appServer ? appServerInterface : help.includes('resume')),
      structuredEvents: capability(
        appServer
          ? appServerInterface
          : help.includes(engine === 'claude-code' ? '--output-format' : '--json')
      ),
      cancel: 'unverified',
      readOnly:
        engine === 'codex'
          ? 'unsupported'
          : help.includes(engine === 'claude-code' ? '--permission-mode' : '--mode')
            ? 'unverified'
            : 'unsupported'
    }
  };
}
