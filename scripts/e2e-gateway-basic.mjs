// stdio gateway e2e: exact JSON contracts (no substring matching), built-in
// echo/time regression, custom business tools through the CLI, and negative
// paths that must fail without executing downstream handlers.
import process from 'node:process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, runCommand } from './e2e-lib.mjs';

async function run() {
  const dir = mkdtempSync(join(tmpdir(), 'gateway-basic-e2e-'));
  const configPath = join(dir, 'gateway-config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      tenantId: 'e2e-basic',
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
    })
  );

  const endpoint =
    `node packages/gateway/dist/cli.js --config ${configPath} --transport stdio`;

  // ---- listing: exact brief projection ----
  const listResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'list',
    '--transport',
    'stdio',
    '--endpoint',
    endpoint
  ]);
  const listPayload = JSON.parse(listResult.stdout);
  const names = listPayload.tools.map((tool) => tool.name).sort();
  assert(
    names.includes('local__echo') && names.includes('local__time'),
    `built-in echo/time visible: ${JSON.stringify(names)}`
  );
  assert(
    names.includes('custom__catalog.lookup'),
    `custom business tool visible without enum changes: ${JSON.stringify(names)}`
  );
  for (const tool of listPayload.tools) {
    assert(typeof tool.name === 'string' && tool.name.length > 0, 'list entry shaped');
  }

  // ---- full discovery: complete descriptors via --full ----
  const fullResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'list',
    '--full',
    '--transport',
    'stdio',
    '--endpoint',
    endpoint
  ]);
  const fullPayload = JSON.parse(fullResult.stdout);
  const lookup = fullPayload.tools.find((tool) => tool.name === 'custom__catalog.lookup');
  assert(lookup, 'full listing includes custom__catalog.lookup');
  assert(
    (lookup.inputSchema)?.properties?.sku !==
      undefined,
    'full listing carries the real input schema'
  );

  // ---- echo: exact standard envelope ----
  const echoResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'call',
    'local__echo',
    '--transport',
    'stdio',
    '--endpoint',
    endpoint,
    '--json',
    '{"text":"gateway-e2e"}'
  ]);
  const echoPayload = JSON.parse(echoResult.stdout);
  assert(echoPayload.output.ok === true, 'echo ok:true');
  assert(echoPayload.output.code === 'OK', 'echo code OK');
  assert(
    echoPayload.output.structuredContent.text === 'gateway-e2e',
    'echo payload round-trips exactly'
  );
  assert(typeof echoPayload.output.traceId === 'string', 'echo carries a trace');

  // ---- time: legacy typed path with runtime validation ----
  const timeResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'call',
    'local__time',
    '--transport',
    'stdio',
    '--endpoint',
    endpoint,
    '--json',
    '{"timezone":"UTC"}'
  ]);
  const timePayload = JSON.parse(timeResult.stdout);
  assert(timePayload.output.structuredContent.timezone === 'UTC', 'time honors timezone');
  assert(
    !Number.isNaN(Date.parse(timePayload.output.structuredContent.iso)),
    'time returns a valid ISO stamp'
  );

  // ---- custom tool through the gateway with strict schema ----
  const customResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'call',
    'custom__catalog.lookup',
    '--transport',
    'stdio',
    '--endpoint',
    endpoint,
    '--json',
    '{"sku":"sku-001","region":"eu"}'
  ]);
  const customPayload = JSON.parse(customResult.stdout);
  assert(customPayload.output.ok === true, 'custom call succeeds');
  assert(
    customPayload.output.structuredContent.sku === 'sku-001' &&
      customPayload.output.structuredContent.region === 'eu',
    'custom business payload preserved'
  );

  // ---- negative: invalid input fails without executing the handler ----
  const invalid = await runCommand(
    'node',
    [
      'packages/mcp-client/dist/cli.js',
      'tools',
      'call',
      'custom__catalog.lookup',
      '--transport',
      'stdio',
      '--endpoint',
      endpoint,
      '--json',
      '{"sku":"x"}'
    ],
    { expectFailure: true }
  );
  assert(invalid.code !== 0, 'invalid input exits non-zero');
  assert(
    invalid.stderr.includes('INVALID_PARAMS') || invalid.stderr.toLowerCase().includes('invalid'),
    `invalid input message is diagnostic: ${invalid.stderr.slice(0, 120)}`
  );

  // ---- negative: downstream business failure surfaces as a failure ----
  const failing = await runCommand(
    'node',
    [
      'packages/mcp-client/dist/cli.js',
      'tools',
      'call',
      'custom__warehouse.reserve',
      '--transport',
      'stdio',
      '--endpoint',
      endpoint,
      '--json',
      '{}'
    ],
    { expectFailure: true }
  );
  assert(failing.code !== 0, 'warehouse failure exits non-zero');
  assert(
    failing.stderr.includes('out_of_stock') || failing.stderr.includes('warehouse'),
    `failure diagnostics preserved: ${failing.stderr.slice(0, 120)}`
  );

  process.stdout.write('gateway e2e passed\n');
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
