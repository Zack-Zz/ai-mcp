// Real-client HTTP e2e: schema flow, error semantics, two-client ownership,
// audit continuity and resource reclamation over built dist artifacts.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';
// Independent validation through the built shared package (dist), proving
// the public schema compiler artifact works outside the test harness.
import { createSchemaCompiler } from '../packages/shared/dist/index.js';
import {
  assert,
  canBindPort,
  getFreePort,
  openSession,
  rpcPost,
  spawnLongRunning,
  stopProcess,
  waitForReady
} from './e2e-lib.mjs';

const gatewayPort = await getFreePort();
const gatewayEndpoint = `http://localhost:${gatewayPort}/mcp`;
const dir = mkdtempSync(join(tmpdir(), 'gateway-http-e2e-'));
const auditPath = join(dir, 'audit.jsonl');
const configPath = join(dir, 'gateway-config.json');

writeFileSync(
  configPath,
  JSON.stringify(
    {
      tenantId: 'e2e-http',
      policy: {
        allowTools: [
            'local__echo',
            'custom__catalog.lookup',
            'custom__warehouse.reserve',
            'custom__tasks.get',
            'custom__report.status',
            'custom__probe.overlap'
          ],
        rateLimit: { windowMs: 60_000, maxRequests: 1000 }
      },
      auditFilePath: auditPath,
      backends: [
        {
          id: 'local',
          transport: 'stdio',
          command: 'node',
          args: ['packages/mcp-server/dist/cli.js', '--transport', 'stdio'],
          cwd: process.cwd()
        },
        {
          id: 'custom',
          transport: 'stdio',
          command: 'node',
          args: ['scripts/fixtures/custom-tools-server.mjs'],
          cwd: process.cwd()
        }
      ]
    },
    null,
    2
  )
);

const gateway = spawnLongRunning(
  'node',
  ['packages/gateway/dist/cli.js', '--config', configPath, '--transport', 'http', '--port', String(gatewayPort)],
  'gateway'
);

try {
  await waitForReady(gateway, /mcp-gateway started on http:\/\//, 'gateway');

  // ---- A03: advertised schema independently validates real results ----
  const session = await openSession(gatewayEndpoint);
  const listResponse = await rpcPost(
    gatewayEndpoint,
    { jsonrpc: '2.0', id: 100, method: 'tools/list' },
    {},
    session.sessionId
  );
  const tools = listResponse.body?.result?.tools ?? [];
  const lookup = tools.find((tool) => tool.name === 'custom__catalog.lookup');
  assert(lookup, 'custom__catalog.lookup advertised');
  assert(
    lookup.inputSchema?.properties?.sku && lookup.inputSchema.required?.[0] === 'sku',
    'downstream input schema surfaced through the gateway'
  );

  const validator = createSchemaCompiler().compile(lookup.outputSchema);

  const lookupCall = await session.call('custom__catalog.lookup', { sku: 'sku-e2e', region: 'eu' });
  assert(lookupCall.body?.result?.isError !== true, 'catalog lookup succeeded');
  const structured = lookupCall.body.result.structuredContent;
  assert(
    validator.validate(structured).valid,
    `real result validates the advertised schema: ${JSON.stringify(structured)}`
  );
  assert(structured.structuredContent.region === 'eu', 'wrapped payload preserves business data');
  assert(
    !validator.validate({ ...structured, structuredContent: { sku: 42 } }).valid,
    'schema rejects a wrong payload (independent validator works)'
  );

  // Input rejection before the downstream executes.
  const badInput = await session.call('custom__catalog.lookup', { sku: 'x' });
  assert(badInput.body?.result?.isError === true, 'invalid input is an error result');
  assert(
    badInput.body.result.structuredContent?.code === 'INVALID_PARAMS',
    'invalid input carries INVALID_PARAMS machine code'
  );

  // ---- A04: structuredContent error kept as failure across the full chain ----
  const reserveCall = await session.call('custom__warehouse.reserve', {});
  assert(reserveCall.body?.result?.isError === true, 'native isError surfaces as isError');
  assert(
    reserveCall.body.result.structuredContent?.ok === false,
    'failure envelope is ok:false'
  );
  assert(
    reserveCall.body.result.structuredContent?.structuredContent?.reason === 'out_of_stock',
    'structured diagnostics preserved'
  );

  // ---- A05: standard ok:false vs business ok:false vs failed-task query ----
  const reportCall = await session.call('custom__report.status', {});
  assert(reportCall.body?.result?.isError === true, 'standard ok:false becomes a tool failure');
  assert(
    reportCall.body.result.structuredContent?.code === 'REPORT_REJECTED',
    'standard code preserved without double wrapping'
  );

  const taskCall = await session.call('custom__tasks.get', { id: 'task-9' });
  assert(taskCall.body?.result?.isError !== true, 'querying a failed task stays successful');
  assert(
    taskCall.body.result.structuredContent?.structuredContent?.task?.state === 'failed',
    'business failure data passes through untouched'
  );

  // ---- A07/A09: two clients, overlapping barrier calls, close isolation ----
  const clientA = await openSession(gatewayEndpoint);
  const clientB = await openSession(gatewayEndpoint);
  const pendingA = clientA.call('custom__probe.overlap', { marker: 'e2e-A' });
  const pendingB = clientB.call('custom__probe.overlap', { marker: 'e2e-B' });
  const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
  assert(
    resultA.body?.result?.structuredContent?.structuredContent?.marker === 'e2e-A' &&
      resultB.body?.result?.structuredContent?.structuredContent?.marker === 'e2e-B',
    'overlapping barrier calls return per-client markers (no cross-talk)'
  );

  // Close A mid-flight while B holds the barrier; B must complete and survive.
  const clientC = await openSession(gatewayEndpoint);
  const clientD = await openSession(gatewayEndpoint);
  const inflight = clientD.call('custom__tasks.get', { id: 'during-close' });
  await clientC.close();
  const afterClose = await inflight;
  assert(afterClose.body?.result?.isError !== true, "D's in-flight call survives C's close");
  const dAgain = await clientD.call('custom__tasks.get', { id: 'after-close' });
  assert(dAgain.body?.result?.isError !== true, 'D can still call after C closed');
  await clientD.close();
  const deadSession = await rpcPost(
    gatewayEndpoint,
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    {},
    clientC.sessionId
  );
  assert(deadSession.status === 404, "C's session is gone after DELETE");

  // ---- Policy numeric codes are machine fields ----
  const limited = mkdtempSync(join(tmpdir(), 'gw-limited-'));
  const limitedConfig = join(limited, 'config.json');
  writeFileSync(
    limitedConfig,
    JSON.stringify({
      tenantId: 'e2e-limited',
      policy: {
        allowTools: ['local__echo'],
        rateLimit: { windowMs: 60_000, maxRequests: 1 }
      },
      auditFilePath: join(limited, 'audit.jsonl'),
      backends: [
        {
          id: 'local',
          transport: 'stdio',
          command: 'node',
          args: ['packages/mcp-server/dist/cli.js', '--transport', 'stdio'],
          cwd: process.cwd()
        }
      ]
    })
  );
  const limitedPort = await getFreePort();
  const limitedGateway = spawnLongRunning(
    'node',
    ['packages/gateway/dist/cli.js', '--config', limitedConfig, '--transport', 'http', '--port', String(limitedPort)],
    'limited-gateway'
  );
  await waitForReady(limitedGateway, /mcp-gateway started on http:\/\//, 'limited-gateway');
  const limitedSession = await openSession(`http://localhost:${limitedPort}/mcp`);
  await limitedSession.call('local__echo', { text: 'first' });
  const second = await limitedSession.call('local__echo', { text: 'second' });
  assert(second.body?.error?.code === -32010, `rate limit is a numeric JSON-RPC code: ${JSON.stringify(second.body)}`);
  assert(
    second.body.error.data?.category === 'rate_limited',
    'category rides in error.data'
  );
  // The denial must be persisted by the limited gateway before shutdown.
  await sleep(200);
  await limitedSession.close();
  await stopProcess(limitedGateway, 'limited-gateway');
  const limitedAudit = readFileSync(join(limited, 'audit.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  const denied = limitedAudit.find((line) => line.decision === 'deny');
  assert(denied, 'rate-limit denial recorded as deny');
  assert(denied.outcome === 'protocol_error', 'denial carries a protocol_error outcome');
  assert(denied.traceId, 'denial carries a trace');

  // ---- A12: trace/run/task flow into the JSONL audit ----
  const traced = await session.call('custom__catalog.lookup', { sku: 'sku-trace' }, {
    'org.ai-mcp/context': { traceId: 'e2e-trace-42', runId: 'e2e-run-7', taskId: 'e2e-task-9' }
  });
  assert(traced.body?.result?.isError !== true, 'traced call succeeded');
  await sleep(300);

  const auditLines = readFileSync(auditPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
  assert(auditLines.length > 0, 'audit file has events');
  for (const line of auditLines) {
    assert(typeof line === 'object', 'each audit line is standalone JSON');
  }
  const tracedEvent = auditLines.find((line) => line.traceId === 'e2e-trace-42');
  assert(tracedEvent, 'explicit trace lands in JSONL');
  assert(
    tracedEvent.runId === 'e2e-run-7' && tracedEvent.taskId === 'e2e-task-9',
    'run/task ride on the same audit event'
  );
  assert(tracedEvent.downstream?.backendId === 'custom', 'downstream target recorded');
  assert(tracedEvent.outcome === 'success', 'outcome recorded');
  assert(tracedEvent.invocationId, 'invocation id recorded');
  const toolError = auditLines.find(
    (line) => line.toolName === 'custom__warehouse.reserve' && line.outcome === 'tool_error'
  );
  assert(toolError, 'native error recorded as tool_error outcome');
  const mainDeny = auditLines.find((line) => line.decision === 'deny');
  void mainDeny;

  await session.close();
  await clientA.close();
  await clientB.close();

  // ---- Resource reclamation: SIGTERM exits and frees the port ----
  await stopProcess(gateway, 'gateway');
  const portFree = await canBindPort(gatewayPort);
  assert(portFree, `gateway port ${gatewayPort} is reusable after SIGTERM`);
  assert(gateway.exitCode !== null || gateway.signalCode === 'SIGTERM', 'gateway process exited');

  process.stdout.write('gateway http/policy/audit e2e passed\n');
} finally {
  await stopProcess(gateway, 'gateway');
  void spawn;
}
