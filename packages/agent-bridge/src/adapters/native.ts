import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { BridgeError } from '../contracts/errors.js';
import type { LaunchInput } from '../contracts/types.js';
import type { EngineConfig, EngineId } from '../contracts/validation.js';

export function validateConfig(engine: EngineId, config: EngineConfig): void {
  if (engine !== 'codex' && config.codexTransport !== undefined)
    throw new BridgeError('INVALID_CONFIG', 'codexTransport applies only to Codex');
  // args is a launcher prefix (e.g. node /absolute/zcode.cjs), never engine controls.
  if (config.args.some((arg) => !isAbsolute(arg) || /[\n\r\0]/.test(arg)))
    throw new BridgeError(
      'INVALID_CONFIG',
      'Engine args must be absolute launcher paths; driver controls cannot be overridden'
    );
  if (engine !== 'claude-code' && config.pluginDirs.length)
    throw new BridgeError(
      'UNSUPPORTED_CAPABILITY',
      'This engine has no verified per-run plugin-directory interface'
    );
  if (config.pluginDirs.some((path) => !isAbsolute(path)))
    throw new BridgeError('INVALID_CONFIG', 'Plugin directories must be absolute paths');
}

export function nativeArgs(engine: EngineId, input: LaunchInput): string[] {
  validateConfig(engine, input.config);
  if (
    input.sessionId &&
    !(
      engine === 'zcode' ? /^sess_[A-Za-z0-9_-]+$/ : /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i
    ).test(input.sessionId)
  )
    throw new BridgeError('INVALID_ARGUMENT', 'Invalid native session ID');
  const readOnly = input.permissionProfile === 'read-only';
  if (engine === 'codex' && readOnly)
    throw new BridgeError(
      'UNSUPPORTED_CAPABILITY',
      'Codex read-only execution is disabled: its native shell sandbox did not prevent apply_patch writes in real validation'
    );
  if (engine === 'codex')
    return input.sessionId
      ? [
          '--sandbox',
          input.permissionProfile,
          'exec',
          'resume',
          input.sessionId,
          '--json',
          '--',
          input.prompt
        ]
      : ['exec', '--json', '--sandbox', input.permissionProfile, '--', input.prompt];
  if (engine === 'zcode')
    return [
      ...(input.prompt.startsWith('-') ? [`--prompt=${input.prompt}`] : ['--prompt', input.prompt]),
      '--cwd',
      input.cwd,
      '--json',
      '--mode',
      readOnly ? 'plan' : 'edit',
      '--disallowed-tools',
      readOnly ? 'Bash,Edit,Write' : 'Bash',
      ...(input.sessionId ? ['--resume', input.sessionId] : [])
    ];
  const tools = readOnly ? 'Read,Glob,Grep,Skill' : 'Read,Glob,Grep,Skill,Edit,Write';
  return [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    readOnly ? 'plan' : 'acceptEdits',
    '--tools',
    tools,
    '--allowedTools',
    tools,
    '--disallowedTools',
    readOnly ? 'Bash,Edit,Write' : 'Bash',
    '--settings',
    JSON.stringify({ permissions: { deny: ['Edit(./.git/**)', 'Write(./.git/**)'] } }),
    ...(input.sessionId ? ['--resume', input.sessionId] : ['--session-id', randomUUID()]),
    ...input.config.pluginDirs.flatMap((path) => ['--plugin-dir', path]),
    '--',
    input.prompt
  ];
}
