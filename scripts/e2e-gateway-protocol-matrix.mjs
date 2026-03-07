import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

function waitForReady(processRef, readyPattern, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not become ready within timeout`));
    }, 20_000);

    function cleanup() {
      clearTimeout(timeout);
      processRef.stderr.off('data', onStderr);
      processRef.off('exit', onExit);
      processRef.off('error', onError);
    }

    function onStderr(chunk) {
      const text = String(chunk);
      process.stderr.write(`[matrix:${label}] ${text}`);
      if (readyPattern.test(text)) {
        cleanup();
        resolve();
      }
    }

    function onExit(code) {
      cleanup();
      reject(new Error(`${label} exited before ready (code=${code ?? 'null'})`));
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    processRef.stderr.on('data', onStderr);
    processRef.on('exit', onExit);
    processRef.on('error', onError);
  });
}

function spawnLongRunning(command, args, label) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[matrix:${label}] ${String(chunk)}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[matrix:${label}] ${String(chunk)}`);
  });

  return child;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      const text = String(chunk);
      stdout += text;
      process.stdout.write(`[matrix:cmd] ${text}`);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(`[matrix:cmd] ${text}`);
    });
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`command failed (${command} ${args.join(' ')}): ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function assertProtocolWorks(gatewayEndpoint, protocolVersion) {
  const listResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'list',
    '--transport',
    'http',
    '--endpoint',
    gatewayEndpoint,
    '--protocolVersion',
    protocolVersion
  ]);
  if (!listResult.stdout.includes('local__echo')) {
    throw new Error(`local__echo missing for protocol ${protocolVersion}`);
  }

  const callResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'call',
    'local__echo',
    '--transport',
    'http',
    '--endpoint',
    gatewayEndpoint,
    '--protocolVersion',
    protocolVersion,
    '--json',
    JSON.stringify({ text: protocolVersion })
  ]);
  if (!callResult.stdout.includes(protocolVersion)) {
    throw new Error(
      `expected echo result to include protocol ${protocolVersion}, got: ${callResult.stdout}`
    );
  }

  process.stdout.write(`[matrix] protocol ${protocolVersion} passed\n`);
}

async function run() {
  const gatewayPort = await getFreePort();
  const gatewayEndpoint = `http://localhost:${gatewayPort}/mcp`;
  const gateway = spawnLongRunning(
    'node',
    [
      'packages/gateway/dist/cli.js',
      '--config',
      'examples/gateway-basic/gateway-config.json',
      '--transport',
      'http',
      '--port',
      String(gatewayPort),
      '--allowLegacyHttpSse',
      'true'
    ],
    'gateway'
  );

  const stop = async () => {
    gateway.kill('SIGTERM');
    await sleep(200);
  };

  try {
    await waitForReady(gateway, /mcp-gateway started on http:\/\//, 'gateway');

    await assertProtocolWorks(gatewayEndpoint, '2025-11-25');
    await assertProtocolWorks(gatewayEndpoint, '2025-03-26');
    await assertProtocolWorks(gatewayEndpoint, '2024-11-05');

    process.stdout.write('gateway protocol matrix e2e passed\n');
  } finally {
    await stop();
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate free port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on('error', reject);
  });
}
