import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { setTimeout as sleep } from 'node:timers/promises';

function spawnLongRunning(command, args, label) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.stdout.on('data', (chunk) => {
    process.stdout.write(`[http-e2e:${label}] ${String(chunk)}`);
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(`[http-e2e:${label}] ${String(chunk)}`);
  });

  return child;
}

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

async function runClientCalls(gatewayEndpoint) {
  const listResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'list',
    '--transport',
    'http',
    '--endpoint',
    gatewayEndpoint
  ]);
  if (!listResult.stdout.includes('local__echo')) {
    throw new Error(`local__echo missing: ${listResult.stdout}`);
  }

  await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'call',
    'local__echo',
    '--transport',
    'http',
    '--endpoint',
    gatewayEndpoint,
    '--json',
    JSON.stringify({ text: 'first-call' })
  ]);

  const denied = await runCommand(
    'node',
    [
      'packages/mcp-client/dist/cli.js',
      'tools',
      'call',
      'local__echo',
      '--transport',
      'http',
      '--endpoint',
      gatewayEndpoint,
      '--json',
      JSON.stringify({ text: 'second-call' })
    ],
    { expectFailure: true }
  );

  if (!denied.stderr.includes('-32010') && !denied.stderr.includes('rate limit')) {
    throw new Error(`expected second call to be denied by rate limit, got: ${denied.stderr}`);
  }
}

async function run() {
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
          allowTools: ['local__echo'],
          rateLimit: {
            windowMs: 60_000,
            maxRequests: 1
          }
        },
        auditFilePath: auditPath,
        backends: [
          {
            id: 'local',
            transport: 'stdio',
            command: 'node',
            args: ['packages/mcp-server/dist/cli.js', '--transport', 'stdio'],
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
    [
      'packages/gateway/dist/cli.js',
      '--config',
      configPath,
      '--transport',
      'http',
      '--port',
      String(gatewayPort)
    ],
    'gateway'
  );

  const stop = async () => {
    gateway.kill('SIGTERM');
    await sleep(200);
  };

  try {
    await waitForReady(gateway, /mcp-gateway started on http:\/\//, 'gateway');

    const notFound = await fetch(`http://localhost:${gatewayPort}/not-found`);
    if (notFound.status !== 404) {
      throw new Error(`expected 404 on unknown path, got ${notFound.status}`);
    }

    await runClientCalls(gatewayEndpoint);

    const rawAudit = readFileSync(auditPath, 'utf8');
    const lines = rawAudit
      .trim()
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));

    if (!lines.some((line) => line.decision === 'deny')) {
      throw new Error(`expected deny event in audit log, got: ${rawAudit}`);
    }
    if (!lines.some((line) => String(line.reason ?? '').includes('rate limit exceeded'))) {
      throw new Error(`expected rate limit reason in audit log, got: ${rawAudit}`);
    }

    process.stdout.write('gateway http/policy/audit e2e passed\n');
  } finally {
    await stop();
  }
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});

function runCommand(command, args, options = {}) {
  const expectFailure = options.expectFailure ?? false;

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
      process.stdout.write(`[http-e2e:cmd] ${text}`);
    });
    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(`[http-e2e:cmd] ${text}`);
    });
    child.on('close', (code) => {
      if (code !== 0 && !expectFailure) {
        reject(new Error(`command failed (${command} ${args.join(' ')}): ${stderr}`));
        return;
      }
      if (code === 0 && expectFailure) {
        reject(
          new Error(`expected command failure but got success (${command} ${args.join(' ')})`)
        );
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

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
