import { spawn } from 'node:child_process';
import process from 'node:process';
import console from 'node:console';
import { Buffer } from 'node:buffer';
import { setInterval } from 'node:timers';
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.FIXTURE_ARGV_FILE)
  writeFileSync(
    process.env.FIXTURE_ARGV_FILE,
    JSON.stringify({
      args,
      cwd: process.cwd(),
      bridgeKeys: Object.keys(process.env).filter((key) => /^AGENT_BRIDGE_/i.test(key)),
      nativeAuthPreserved: process.env.ANTHROPIC_API_KEY === 'native-auth-fixture',
      positionalPrompt: args.includes('--') ? args.slice(args.indexOf('--') + 1) : []
    })
  );
const engine = process.env.FIXTURE_ENGINE;
if (
  process.env.FIXTURE_MODE === 'env-check' &&
  Object.keys(process.env).some((key) => /^AGENT_BRIDGE_/i.test(key))
)
  process.exit(5);
if (args[0] === 'features' && args[1] === 'list') {
  console.log(
    process.env.FIXTURE_MODE === 'no-shell-control'
      ? 'other_feature stable true'
      : 'shell_tool stable true\nunified_exec stable true'
  );
  process.exit(0);
}
if (args.includes('--version')) {
  console.log('fixture 1.0');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log(
    engine === 'claude-code'
      ? '--print --output-format --session-id --resume --tools --permission-mode --plugin-dir'
      : engine === 'codex'
        ? 'exec resume --json --sandbox'
        : '--prompt --json --resume --mode --disallowed-tools --cwd'
  );
  process.exit(0);
}
const resumed = args.includes('--resume')
  ? args[args.indexOf('--resume') + 1]
  : args.includes('resume')
    ? args[args.indexOf('resume') + 1]
    : undefined;
const id =
  resumed ?? (engine === 'zcode' ? 'sess_fixture' : '12345678-1234-4234-9234-123456789abc');
const mode = process.env.FIXTURE_MODE;
const frames =
  engine === 'claude-code'
    ? [
        { type: 'system', subtype: 'init', session_id: id },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'hello 世界' }] } },
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: id,
          result: 'done',
          usage: { input_tokens: 3 }
        }
      ]
    : engine === 'codex'
      ? [
          { type: 'thread.started', thread_id: id },
          { type: 'item.completed', item: { type: 'agent_message', text: 'hello 世界' } },
          { type: 'turn.completed', usage: { input_tokens: 3 } }
        ]
      : [
          {
            type: 'result',
            sessionId: id,
            response: 'done 世界',
            usage: { inputTokens: 3 },
            projection: { status: 'idle' }
          }
        ];
if (mode === 'tree') {
  const child = spawn(
    process.execPath,
    ['-e', 'process.on("SIGINT",()=>{}); process.on("SIGTERM",()=>{}); setInterval(()=>{},1000)'],
    { stdio: 'ignore' }
  );
  writeFileSync(process.env.FIXTURE_PID_FILE, String(child.pid));
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
} else if (mode === 'hang') {
  setInterval(() => {}, 1000);
} else if (mode === 'orphan-terminal') {
  const descendant = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], {
    stdio: 'ignore'
  });
  descendant.unref();
  writeFileSync(process.env.FIXTURE_PID_FILE, String(descendant.pid));
  console.log(frames.map((frame) => JSON.stringify(frame)).join('\n'));
} else if (mode === 'fake') {
  console.log(JSON.stringify({ type: 'hello' }));
} else if (mode === 'bad') {
  console.log('broken json');
  console.log(JSON.stringify(frames.at(-1)));
} else if (mode === 'missing-session') {
  const f = frames.at(-1);
  delete f.session_id;
  delete f.sessionId;
  console.log(JSON.stringify(f));
} else if (mode === 'missing-terminal-status') {
  const f = frames.at(-1);
  delete f.projection;
  console.log(JSON.stringify(f));
} else if (mode === 'busy-terminal') {
  frames.at(-1).projection = { status: 'running' };
  console.log(JSON.stringify(frames.at(-1)));
} else if (mode === 'mismatch') {
  frames[0].session_id = 'another';
  frames[0].thread_id = 'another';
  frames[0].sessionId = 'another';
  console.log(frames.map((f) => JSON.stringify(f)).join('\n'));
} else if (mode === 'loglimit') {
  process.stdout.write('x'.repeat(10000));
  setInterval(() => {}, 1000);
} else {
  if (mode === 'secrets') {
    process.stderr.write('Authorization: Bearer top-secret-value\n');
    frames.at(-1).api_key = 'top-secret-value';
    if (engine === 'zcode') frames.at(-1).response = 'token=top-secret-value';
    else if (engine === 'claude-code') frames.at(-1).result = 'token=top-secret-value';
    else frames[1].item.text = 'token=top-secret-value';
  }
  if (mode === 'argv')
    frames.splice(1, 0, { type: 'fixture.argv', argv: args, cwd: process.cwd() });
  if (mode === 'failure') {
    if (engine === 'codex') frames.push({ type: 'turn.failed', error: { message: 'failure' } });
    else frames.at(-1).is_error = true;
  }
  const output = frames.map((f) => JSON.stringify(f)).join('\n');
  if (mode === 'chunks') {
    const data = Buffer.from(output);
    for (let i = 0; i < data.length; i += 3) process.stdout.write(data.subarray(i, i + 3));
  } else process.stdout.write(output + '\n');
  if (mode === 'failure') process.exitCode = 7;
}
