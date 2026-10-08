// Protocol matrix e2e: real initialize bodies, negotiated response versions
// and follow-up headers, plus CLI regression across supported versions.
import process from 'node:process';
import {
  assert,
  getFreePort,
  openSession,
  rpcPost,
  spawnLongRunning,
  stopProcess,
  waitForReady
} from './e2e-lib.mjs';

async function runCliWithVersion(endpoint, protocolVersion) {
  const { runCommand } = await import('./e2e-lib.mjs');
  return runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'list',
    '--transport',
    'http',
    '--endpoint',
    endpoint,
    ...(protocolVersion ? ['--protocolVersion', protocolVersion] : [])
  ]);
}

async function main() {
  // ---- default gateway: legacy disabled ----
  const defaultPort = await getFreePort();
  const defaultEndpoint = `http://localhost:${defaultPort}/mcp`;
  const gatewayDefault = spawnLongRunning(
    'node',
    [
      'packages/gateway/dist/cli.js',
      '--config',
      'examples/gateway-basic/gateway-config.json',
      '--transport',
      'http',
      '--port',
      String(defaultPort)
    ],
    'gateway-default'
  );
  try {
    await waitForReady(gatewayDefault, /mcp-gateway started on http:\/\//, 'gateway-default');

    // A11: initialize body carries the requested version, the response
    // negotiates it back, and follow-up requests carry the header.
    for (const version of ['2025-11-25', '2025-03-26']) {
      const session = await openSession(defaultEndpoint, { protocolVersion: version });
      assert(
        session.negotiated === version,
        `negotiated version echoed: expected ${version}, got ${String(session.negotiated)}`
      );
      const call = await session.call('local__echo', { text: `matrix-${version}` });
      assert(
        call.body?.result?.isError !== true,
        `echo call under ${version}: ${JSON.stringify(call.body).slice(0, 140)}`
      );
      const marker = call.body.result.structuredContent?.structuredContent?.text;
      assert(marker === `matrix-${version}`, 'echo payload survived the negotiated protocol');
      await session.close();
    }

    // Legacy 2024-11-05 must be rejected by default policy (body AND header).
    const legacyInit = await rpcPost(defaultEndpoint, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'legacy-probe', version: '0' }
      }
    });
    assert(legacyInit.status === 400, `legacy body rejected by default: ${legacyInit.status}`);

    const unknownVersion = await rpcPost(defaultEndpoint, {
      jsonrpc: '2.0',
      id: 2,
      method: 'initialize',
      params: {
        protocolVersion: '1999-01-01',
        capabilities: {},
        clientInfo: { name: 'unknown-probe', version: '0' }
      }
    });
    assert(unknownVersion.status === 400, 'unknown version rejected');

    // CLI regression: default and explicit versions still work end-to-end.
    const defaultCli = await runCliWithVersion(defaultEndpoint, undefined);
    assert(defaultCli.stdout.includes('local__echo'), 'CLI default list sees local__echo');
    for (const version of ['2025-11-25', '2025-03-26']) {
      const cli = await runCliWithVersion(defaultEndpoint, version);
      assert(cli.stdout.includes('local__echo'), `CLI list works with ${version}`);
    }
    const legacyCli = await import('./e2e-lib.mjs').then((lib) =>
      lib.runCommand(
        'node',
        [
          'packages/mcp-client/dist/cli.js',
          'tools',
          'list',
          '--transport',
          'http',
          '--endpoint',
          defaultEndpoint,
          '--protocolVersion',
          '2024-11-05'
        ],
        { expectFailure: true }
      )
    );
    assert(legacyCli.code !== 0, 'CLI with legacy version fails against default policy');
  } finally {
    await stopProcess(gatewayDefault, 'gateway-default');
  }

  // ---- explicit legacy enablement ----
  const legacyPort = await getFreePort();
  const legacyEndpoint = `http://localhost:${legacyPort}/mcp`;
  const gatewayLegacy = spawnLongRunning(
    'node',
    [
      'packages/gateway/dist/cli.js',
      '--config',
      'examples/gateway-basic/gateway-config.json',
      '--transport',
      'http',
      '--port',
      String(legacyPort),
      '--allowLegacyHttpSse',
      'true'
    ],
    'gateway-legacy'
  );
  try {
    await waitForReady(gatewayLegacy, /mcp-gateway started on http:\/\//, 'gateway-legacy');
    const session = await openSession(legacyEndpoint, { protocolVersion: '2024-11-05' });
    assert(
      session.negotiated === '2024-11-05',
      `legacy version negotiated when enabled: ${String(session.negotiated)}`
    );
    const call = await session.call('local__echo', { text: 'legacy-ok' });
    assert(call.body?.result?.isError !== true, 'legacy-enabled echo call works');
    await session.close();
  } finally {
    await stopProcess(gatewayLegacy, 'gateway-legacy');
  }

  process.stdout.write('gateway protocol matrix e2e passed\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
