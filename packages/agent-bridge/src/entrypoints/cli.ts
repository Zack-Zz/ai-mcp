import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { BridgeError } from '../contracts/errors.js';
import {
  parseConfig,
  parseStart,
  taskSpecSchema,
  engineSchema,
  type BridgeConfig
} from '../contracts/validation.js';
import { BridgeClient } from '../client/index.js';
import { endpoint, privateDirectory, readPrivate, writeExclusive } from '../client/security.js';
import { errorReply } from '../client/protocol.js';
import { digest } from '../runtime/journal.js';
import { serveRuntime } from '../runtime/ipc.js';

export type CliCommand = {
  operation: string;
  values: Record<string, string | boolean>;
  positionals: string[];
  json: boolean;
  help: boolean;
  configPath?: string;
  callerRef?: string;
};
const commandOptions: Record<string, string[]> = {
  'engine.list': [],
  preflight: ['engine', 'project', 'spec-file', 'workspace-policy', 'independent-session'],
  'task.start': [
    'engine',
    'project',
    'spec-file',
    'workspace-policy',
    'request-id',
    'independent-session'
  ],
  'task.get': [],
  'task.list': ['limit', 'cursor'],
  'task.watch': ['cursor', 'wait-ms'],
  'task.continue': ['message-file', 'request-id'],
  'task.cancel': ['request-id'],
  'artifact.list': ['task'],
  'artifact.read': ['task', 'offset', 'limit'],
  'runtime.serve': [],
  'runtime.stop': ['request-id'],
  'mcp.stdio': [],
  'mcp.http': ['port', 'credential-file']
};
const flags = new Set(['json', 'help', 'independent-session']);
const globals = ['config', 'caller-ref', 'json', 'help'];
type InputStream = AsyncIterable<string | Uint8Array>;
export function parseCommand(argv: string[]): CliCommand {
  const values: Record<string, string | boolean> = {};
  const words: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (arg === '-h') {
      values.help = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      if (arg.startsWith('-'))
        throw new BridgeError('INVALID_ARGUMENT', 'Only documented long options are supported');
      words.push(arg);
      continue;
    }
    const [key, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (!key || Object.hasOwn(values, key))
      throw new BridgeError('INVALID_ARGUMENT', 'Duplicate or empty CLI option');
    if (![...globals, ...Object.values(commandOptions).flat()].includes(key))
      throw new BridgeError('INVALID_ARGUMENT', 'Unknown CLI option');
    if (flags.has(key)) {
      if (inline !== undefined)
        throw new BridgeError('INVALID_ARGUMENT', 'Boolean flags do not take values');
      values[key] = true;
      continue;
    }
    const value = inline ?? argv[++index];
    const streamInput = value === '-' && ['spec-file', 'message-file'].includes(key);
    if (value === undefined || (!inline && value.startsWith('-') && !streamInput))
      throw new BridgeError('INVALID_ARGUMENT', `--${key} requires a value`);
    values[key] = value;
  }
  const operation =
    words[0] === 'preflight'
      ? 'preflight'
      : words.length
        ? `${words[0]}.${words[1] ?? ''}`
        : 'help';
  const help = values.help === true || operation === 'help';
  if (operation !== 'help' && !commandOptions[operation])
    throw new BridgeError('INVALID_ARGUMENT', 'Unknown Bridge command; use --help');
  if (
    Object.keys(values).some(
      (key) => !globals.includes(key) && !commandOptions[operation]?.includes(key)
    )
  )
    throw new BridgeError('INVALID_ARGUMENT', 'Option is not valid for this command');
  return {
    operation,
    values,
    positionals: words.slice(operation === 'preflight' ? 1 : 2),
    json: values.json === true,
    help,
    ...(typeof values.config === 'string' ? { configPath: values.config } : {}),
    ...(typeof values['caller-ref'] === 'string' ? { callerRef: values['caller-ref'] } : {})
  };
}
const examples: Record<string, string> = {
  'engine.list': 'engine list --json',
  preflight: 'preflight --engine codex --project sample --json',
  'task.start':
    'task start --engine codex --project sample --spec-file ./task.json --request-id req-1 --json',
  'task.get': 'task get task_123 --json',
  'task.list': 'task list --limit 20 --json',
  'task.watch': 'task watch task_123 --cursor event_7 --wait-ms 30000 --json',
  'task.continue': 'task continue task_123 --message-file ./feedback.txt --request-id req-2 --json',
  'task.cancel': 'task cancel task_123 --request-id req-3 --json',
  'artifact.list': 'artifact list --task task_123 --json',
  'artifact.read': 'artifact read artifact_456 --task task_123 --offset 0 --limit 16384 --json',
  'runtime.serve': 'runtime serve --config ./bridge.json',
  'runtime.stop': 'runtime stop --request-id stop-1 --json',
  'mcp.stdio': 'mcp stdio --config ./bridge.json',
  'mcp.http':
    'mcp http --config ./bridge.json --credential-file ./http-token.json --port 7001 --json'
};
function helpText(operation: string): string {
  if (operation === 'help')
    return `agent-bridge: explicit persistent native-agent tasks\nCommands: ${Object.keys(commandOptions).join(', ')}\nGlobal options: --config PATH --caller-ref ID --json --help\nExample: agent-bridge ${examples['task.start']}\n`;
  const inputHelp = ['preflight', 'task.start', 'task.continue'].includes(operation)
    ? '\nInput: --spec-file PATH or --message-file PATH; use - for bounded UTF-8 stdin.\n'
    : '';
  return `agent-bridge ${operation.replace('.', ' ')}\nOptions: ${(commandOptions[operation] ?? []).map((key) => `--${key}`).join(' ')}\nGlobal options: --config PATH --caller-ref ID --json --help\nExample: agent-bridge ${examples[operation]}\n${inputHelp}`;
}
function value(command: CliCommand, name: string, required = false): string | undefined {
  const text = command.values[name];
  if (typeof text === 'string' && text.length) return text;
  if (required) throw new BridgeError('INVALID_ARGUMENT', `--${name} is required`);
  return undefined;
}
function number(command: CliCommand, name: string, max: number, min = 0): number | undefined {
  const raw = value(command, name);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed > max || parsed < min)
    throw new BridgeError('INVALID_ARGUMENT', `--${name} exceeds its numeric bounds`);
  return parsed;
}
async function readInput(path: string, stdin: InputStream): Promise<string> {
  if (path === '-') {
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stdin) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 4 * 1024 * 1024)
          throw new BridgeError('INVALID_ARGUMENT', 'Input stream exceeds its bound');
        chunks.push(bytes);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('INVALID_ARGUMENT', 'Input stream must contain readable UTF-8 data');
    }
  }
  let file;
  try {
    file = await open(resolve(path), constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new BridgeError('INVALID_ARGUMENT', 'Input file must be an accessible regular file');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new BridgeError('INVALID_ARGUMENT', 'Input file exceeds its bound');
    return await file.readFile('utf8');
  } finally {
    await file.close();
  }
}
async function taskSpec(path: string, stdin: InputStream): Promise<unknown> {
  try {
    return taskSpecSchema.parse(JSON.parse(await readInput(path, stdin)));
  } catch (error) {
    if (error instanceof BridgeError) throw error;
    throw new BridgeError(
      'INVALID_ARGUMENT',
      'Spec file must contain a valid TaskSpec JSON object'
    );
  }
}
async function argumentsFor(
  command: CliCommand,
  stdin: InputStream
): Promise<Record<string, unknown>> {
  const operation = command.operation;
  const needsTask = ['task.get', 'task.watch', 'task.continue', 'task.cancel'].includes(operation);
  const count = needsTask || operation === 'artifact.read' ? 1 : 0;
  if (command.positionals.length !== count)
    throw new BridgeError('INVALID_ARGUMENT', `Expected ${count} task/artifact identity argument`);
  const args: Record<string, unknown> = needsTask ? { taskId: command.positionals[0] } : {};
  const put = (name: string, entry: unknown) => {
    if (entry !== undefined) args[name] = entry;
  };
  if (operation === 'mcp.stdio' && command.json)
    throw new BridgeError(
      'INVALID_ARGUMENT',
      'MCP stdio reserves stdout for protocol messages; omit --json'
    );
  if (operation === 'mcp.http') {
    put('port', number(command, 'port', 65535));
    put('credentialFile', resolve(value(command, 'credential-file', true)!));
  }
  if (['preflight', 'task.start'].includes(operation)) {
    const engine = value(command, 'engine', true);
    if (!engineSchema.safeParse(engine).success)
      throw new BridgeError('INVALID_ARGUMENT', 'Select a canonical engine identity');
    put('engine', engine);
    put('projectId', value(command, 'project', true));
    const file = value(command, 'spec-file', operation === 'task.start');
    if (file) put('taskSpec', await taskSpec(file, stdin));
  }
  if (operation === 'task.start' || operation === 'preflight') {
    put('workspacePolicy', value(command, 'workspace-policy'));
    if (command.values['independent-session']) put('sameEngineIntent', 'independent-session');
  }
  if (operation === 'task.continue') {
    const message = await readInput(value(command, 'message-file', true)!, stdin);
    if (!message.trim() || message.length > 32000)
      throw new BridgeError(
        'INVALID_ARGUMENT',
        'Message must contain between 1 and 32000 characters'
      );
    put('message', message);
  }
  if (operation === 'task.list') {
    put('limit', number(command, 'limit', 100, 1));
    put('cursor', value(command, 'cursor'));
  }
  if (operation === 'task.watch') {
    put('cursor', value(command, 'cursor'));
    put('waitMs', number(command, 'wait-ms', 50000));
  }
  if (operation.startsWith('artifact.')) put('taskId', value(command, 'task', true));
  if (operation === 'artifact.read') {
    put('artifactId', command.positionals[0]);
    put('offset', number(command, 'offset', Number.MAX_SAFE_INTEGER));
    put('limit', number(command, 'limit', 65536, 1));
  }
  return args;
}
export async function bootstrapRuntime(configPath: string): Promise<void> {
  const source = import.meta.url.endsWith('.ts');
  const entry = source
    ? fileURLToPath(new URL('../cli.ts', import.meta.url))
    : fileURLToPath(import.meta.url);
  const prefix = source ? ['--import', fileURLToPath(import.meta.resolve('tsx/esm'))] : [];
  const child = spawn(
    process.execPath,
    [...prefix, entry, 'runtime', 'serve', '--config', configPath],
    { detached: true, stdio: 'ignore', shell: false }
  );
  await new Promise<void>((resolveSpawn, reject) => {
    child.once('spawn', resolveSpawn);
    child.once('error', () =>
      reject(new BridgeError('RUNTIME_UNAVAILABLE', 'Runtime bootstrap could not start'))
    );
  });
  child.unref();
}
async function receipt(
  config: BridgeConfig,
  callerRef: string,
  operation: string,
  args: Record<string, unknown>
): Promise<string> {
  const id = args.requestId;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(id))
    throw new BridgeError('INVALID_ARGUMENT', 'Invalid requestId');
  const target = await endpoint(config);
  const directory = await privateDirectory(join(target.stateRoot, 'operations', digest(callerRef)));
  const path = join(directory, `${id}.json`);
  const body = {
    apiVersion: 'agent-bridge/v1',
    requestId: id,
    callerRef,
    operation,
    args,
    configHash: target.configHash
  };
  try {
    await writeExclusive(path, JSON.stringify(body));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (digest(JSON.parse(await readPrivate(path))) !== digest(body))
      throw new BridgeError(
        'IDEMPOTENCY_CONFLICT',
        'Saved operation receipt differs; recover with the original requestId and arguments'
      );
  }
  return path;
}
export type CliOptions = {
  stdin?: InputStream;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  connect?: (
    config: BridgeConfig,
    options: { callerRef: string; bootstrap?: () => Promise<void> }
  ) => Promise<{ dispatch(operation: string, args: unknown): Promise<unknown> }>;
  bootstrap?: (configPath: string) => Promise<void>;
};
export async function runCli(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout =
    options.stdout ??
    ((text) => {
      process.stdout.write(text);
    });
  const stderr =
    options.stderr ??
    ((text) => {
      process.stderr.write(text);
    });
  let operation = 'unknown';
  let id: string | undefined;
  let json = argv.includes('--json');
  try {
    const command = parseCommand(argv);
    operation = command.operation;
    json = command.json;
    if (command.help) {
      stdout(helpText(operation));
      return 0;
    }
    const args = await argumentsFor(command, options.stdin ?? process.stdin);
    const configured = command.configPath ?? process.env.AGENT_BRIDGE_CONFIG;
    if (!configured)
      throw new BridgeError(
        'INVALID_CONFIG',
        'Provide --config PATH or controlled AGENT_BRIDGE_CONFIG'
      );
    const configPath = resolve(configured);
    let config: BridgeConfig;
    try {
      config = parseConfig(JSON.parse(await readPrivate(configPath)));
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      throw new BridgeError('INVALID_CONFIG', 'Controlled config file could not be read or parsed');
    }
    const callerRef = command.callerRef ?? config.defaultCallerRef;
    if (!config.clients.some((client) => client.id === callerRef))
      throw new BridgeError('AUTH_REQUIRED', 'Select a configured caller identity');
    if (['task.start', 'task.continue', 'task.cancel', 'runtime.stop'].includes(operation)) {
      id = value(command, 'request-id') ?? `req_${randomUUID()}`;
      args.requestId = id;
      if (operation === 'task.start') Object.assign(args, parseStart(args));
      const saved = await receipt(config, callerRef, operation, args);
      if (!value(command, 'request-id'))
        stderr(`Saved requestId ${id}; recover with --request-id ${id}. Receipt: ${saved}\n`);
    }
    if (operation === 'runtime.serve') {
      const server = await serveRuntime(config);
      const stop = () => {
        void server.close().catch(() => {});
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      stdout(
        json
          ? JSON.stringify({ apiVersion: 'agent-bridge/v1', operation, data: { ready: true } }) +
              '\n'
          : 'Bridge runtime ready\n'
      );
      try {
        await server.closed;
      } finally {
        process.removeListener('SIGINT', stop);
        process.removeListener('SIGTERM', stop);
      }
      return 0;
    }
    const connect = options.connect ?? BridgeClient.connect.bind(BridgeClient);
    const client = await connect(config, {
      callerRef,
      ...(operation === 'runtime.stop'
        ? {}
        : { bootstrap: () => (options.bootstrap ?? bootstrapRuntime)(configPath) })
    });
    if (operation === 'mcp.stdio') {
      const { serveBridgeStdio } = await import('./mcp.js');
      const handle = serveBridgeStdio(client, { onerror: () => stderr('MCP protocol error\n') });
      const stop = () => {
        void handle.close().catch(() => {});
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
      return 0;
    }
    if (operation === 'mcp.http') {
      const { serveBridgeHttp } = await import('./http.js');
      const handle = await serveBridgeHttp(client, {
        ...(typeof args.port === 'number' ? { port: args.port } : {}),
        credentialFile: String(args.credentialFile),
        onerror: () => stderr('MCP HTTP protocol error\n')
      });
      stdout(
        json
          ? JSON.stringify({
              apiVersion: 'agent-bridge/v1',
              operation,
              data: { url: handle.url }
            }) + '\n'
          : `Bridge MCP listening at ${handle.url}\n`
      );
      await new Promise<void>((resolve, reject) => {
        const stop = () => {
          process.removeListener('SIGINT', stop);
          process.removeListener('SIGTERM', stop);
          void handle.close().then(resolve, reject);
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
      return 0;
    }
    const data = await client.dispatch(operation, args);
    const reply = {
      apiVersion: 'agent-bridge/v1',
      operation,
      ...(id ? { requestId: id } : {}),
      data
    };
    stdout(
      json
        ? JSON.stringify(reply) + '\n'
        : `${operation} succeeded${id ? ` (${id})` : ''}${typeof data === 'object' && data && 'taskId' in data ? `; task ${String(data.taskId)}` : ''}\n`
    );
    return 0;
  } catch (error) {
    const reply = errorReply(operation, error, id);
    stderr(`${reply.error!.code}: ${reply.error!.message}\n`);
    if (json) stdout(JSON.stringify(reply) + '\n');
    return [
      'INVALID_ARGUMENT',
      'TARGET_REQUIRED',
      'POLICY_DENIED',
      'AUTH_REQUIRED',
      'IDEMPOTENCY_CONFLICT',
      'UNSUPPORTED_CAPABILITY',
      'TASK_NOT_FOUND',
      'STATE_CONFLICT',
      'WORKSPACE_BUSY',
      'INVALID_VERIFICATION',
      'UNKNOWN_VERIFICATION'
    ].includes(reply.error!.code)
      ? 2
      : 1;
  }
}
