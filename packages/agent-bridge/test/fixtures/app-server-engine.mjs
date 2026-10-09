import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setInterval, setTimeout } from 'node:timers';
import { createInterface } from 'node:readline';
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const argv = process.argv.slice(2);
if (argv.includes('--version')) {
  process.stdout.write('fixture 1.0\n');
  process.exit(0);
}
if (argv.includes('--help')) {
  if (argv[0] === 'app-server') {
    process.stdout.write('app-server --listen stdio://\n');
    process.exit(0);
  }
  process.stderr.write('Unsupported fixture interface\n');
  process.exit(1);
}
const mode = process.env.FIXTURE_MODE || 'normal';
const id = '12345678-1234-4234-9234-123456789abc';
const turnId = 'turn-owned';
let threadId = id;
let approvalId;
const send = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const response = (req, result) => send({ id: req.id, result });
const notify = (method, params) => send({ method, params });
const log = (v) => {
  if (process.env.FIXTURE_LOG) appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(v) + '\n');
};
log({
  args: process.argv.slice(2),
  cwd: process.cwd(),
  bridge: !!process.env.AGENT_BRIDGE_TEST_SECRET,
  sandbox: !!process.env.CODEX_SANDBOX
});
process.on('SIGINT', () => {
  log({ shutdown: 'SIGINT' });
  process.exit(0);
});
if (mode === 'ignore-shutdown') {
  process.removeAllListeners('SIGINT');
  process.on('SIGINT', () => {});
  process.on('SIGTERM', () => {});
}
const rl = createInterface({ input: process.stdin });
rl.on('close', () => {
  log({ shutdown: 'EOF' });
  if (!['ignore-shutdown', 'wait-sigint'].includes(mode)) process.exit(0);
});
setInterval(() => {}, 1000);
rl.on('line', (line) => {
  const req = JSON.parse(line);
  log(req);
  if (!req.method) {
    if (req.id === approvalId) log({ denied: req.error !== undefined });
    return;
  }
  if (req.method === 'initialize') {
    if (mode === 'hang-init') return;
    if (mode === 'rpc-error' || mode === 'rpc-auth-error')
      return send({
        id: req.id,
        error: {
          code: -1,
          message:
            mode === 'rpc-auth-error'
              ? 'Authentication unavailable api_key=top-secret-value'
              : 'api_key=top-secret-value',
          data: { authorization: 'forbidden-secret-field' }
        }
      });
    if (mode === 'wrong-response') return send({ id: 12345, result: {} });
    if (mode === 'bad-json') return process.stdout.write('not-json\n');
    if (mode === 'bad-utf8') return process.stdout.write(Buffer.from([0xff, 0x0a]));
    if (mode === 'log-limit') return process.stdout.write('x'.repeat(5000));
    if (mode === 'startup-noise')
      for (let i = 0; i < 300; i++)
        notify('mcpServer/startupStatus/updated', { name: `module-${i}`, status: 'starting' });
    response(req, { userAgent: 'fixture' });
    return;
  }
  if (req.method === 'initialized') return;
  if (req.method === 'thread/start' || req.method === 'thread/resume') {
    threadId = req.params.threadId || id;
    if (mode === 'wrong-id') threadId = '87654321-4321-4321-9321-cba987654321';
    const thread = {
      id: threadId,
      sessionId: threadId,
      parentThreadId: null,
      forkedFromId: null,
      ephemeral: false,
      cwd: req.params.cwd,
      status: { type: 'idle' }
    };
    if (mode === 'wrong-cwd') thread.cwd = '/not-this-workspace';
    if (mode === 'busy') thread.status.type = 'active';
    if (mode === 'child-session') thread.parentThreadId = id;
    response(req, { thread });
    return;
  }
  if (req.method === 'turn/interrupt') {
    response(req, {});
    notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } });
    return;
  }
  if (req.method !== 'turn/start') return;
  if (mode === 'early-exit') return process.exit(0);
  if (mode === 'pending-turn') return;
  notify('turn/started', { threadId, turn: { id: turnId, status: 'inProgress' } });
  if (mode === 'early-terminal')
    notify('turn/completed', {
      threadId,
      turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', text: 'early' }] }
    });
  response(req, { turn: { id: turnId, status: 'inProgress' } });
  if (mode === 'hang-turn') return;
  if (mode === 'retry-error' || mode === 'fatal-error') {
    notify('error', {
      threadId,
      turnId,
      willRetry: mode === 'retry-error',
      error: {
        message: 'Upstream unavailable api_key=top-secret-value',
        codexErrorInfo: 'serverOverloaded',
        additionalDetails: 'forbidden-secret-field'
      }
    });
    if (mode === 'fatal-error') return;
  }

  if (mode === 'approval' || mode === 'unknown-request') {
    approvalId = 900;
    return send({
      id: approvalId,
      method: mode === 'approval' ? 'item/commandExecution/requestApproval' : 'unknown/privilege',
      params: { threadId, turnId }
    });
  }
  notify('item/completed', {
    threadId: 'another-thread',
    turnId,
    item: { type: 'agentMessage', text: 'foreign' }
  });
  notify('thread/tokenUsage/updated', {
    threadId,
    turnId,
    tokenUsage: { total: { totalTokens: 9 }, apiKey: 'top-secret-value' }
  });
  const text = mode === 'secrets' ? '世界 api_key=top-secret-value' : '世界 done';
  notify('item/completed', { threadId, turnId, item: { type: 'agentMessage', text } });
  notify('item/completed', {
    threadId,
    turnId,
    item: { type: 'commandExecution', command: 'opaque' }
  });
  if (mode === 'secrets') process.stderr.write('token=top-secret-value\n');
  if (mode === 'orphan') {
    const c = spawn(
      process.execPath,
      ['-e', "process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { stdio: 'ignore' }
    );
    c.unref();
    if (process.env.FIXTURE_CHILD_PID) writeFileSync(process.env.FIXTURE_CHILD_PID, String(c.pid));
  }
  if (mode === 'pipe-tail' || mode === 'pipe-tail-hang') {
    const c = spawn(
      process.execPath,
      [
        '-e',
        "setTimeout(()=>{process.stdout.write('bad-tail');process.exit(0)},Number(process.env.FIXTURE_TAIL_MS)||300)"
      ],
      { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }
    );
    c.unref();
    writeFileSync(process.env.FIXTURE_CHILD_PID, String(c.pid));
  }
  if (mode === 'pipe-tail-hang') return;
  const terminal = {
    threadId,
    turn: {
      id: mode === 'wrong-turn' ? 'other-turn' : turnId,
      status: mode === 'failed-turn' ? 'failed' : 'completed',
      items: [{ type: 'agentMessage', text }]
    }
  };
  if (mode === 'turn-auth-error') {
    terminal.turn.status = 'failed';
    terminal.turn.error = {
      codexErrorInfo: 'unauthorized',
      message: 'Provider authentication unavailable api_key=top-secret-value',
      additionalDetails: 'forbidden-secret-field'
    };
  }
  if (mode === 'wrong-thread') terminal.threadId = 'other-thread';
  if (mode === 'chunks') {
    const bytes = Buffer.from(
      JSON.stringify({ method: 'turn/completed', params: terminal }) + '\n'
    );
    const split = bytes.indexOf(Buffer.from('世界')) + 1;
    process.stdout.write(bytes.subarray(0, split));
    setTimeout(() => process.stdout.write(bytes.subarray(split)), 5);
  } else notify('turn/completed', terminal);
});
