import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';
import { setInterval, setTimeout } from 'node:timers';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('fixture-codex integration-1');
  process.exit(0);
}
if (args.includes('--help')) {
  console.log('exec resume --json --sandbox');
  process.exit(0);
}
if (args[0] === 'features') {
  console.log('shell_tool stable true\nunified_exec stable true');
  process.exit(0);
}
const resume = args.includes('resume') ? args[args.indexOf('resume') + 1] : undefined;
const sessionId = resume ?? randomUUID();
const sessionPath = join(process.env.FIXTURE_SESSION_ROOT, `session-${sessionId}.json`);
const previous = resume
  ? JSON.parse(readFileSync(sessionPath, 'utf8'))
  : { sessionId, cwd: process.cwd(), turns: 0 };
if (previous.cwd !== process.cwd() || previous.sessionId !== sessionId)
  throw new Error('Exact session binding mismatch');
writeFileSync(sessionPath, JSON.stringify({ ...previous, turns: previous.turns + 1 }), {
  mode: 0o600
});
appendFileSync(
  process.env.FIXTURE_EXEC_LOG,
  JSON.stringify({ args, cwd: process.cwd(), resume, sessionId }) + '\n',
  { mode: 0o600 }
);
const prompt = args.at(-1);
const frame = (value) => console.log(JSON.stringify(value));
frame({ type: 'thread.started', thread_id: sessionId });
if (prompt.includes('Hold for cancellation')) {
  setInterval(() => {}, 1000);
} else {
  await new Promise((resolve) => setTimeout(resolve, 150));
  if (prompt.includes('Write outside scope')) writeFileSync('src/forbidden.txt', 'Out of scope');
  else writeFileSync('src/value.txt', prompt.includes('Set value TWO') ? 'TWO' : 'ONE');
  frame({
    type: 'item.completed',
    item: { type: 'agent_message', text: 'Fixture delivery complete' }
  });
  frame({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
}
