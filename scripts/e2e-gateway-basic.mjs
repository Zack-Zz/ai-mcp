import { spawn } from 'node:child_process';
import process from 'node:process';

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
      process.stdout.write(`[e2e] ${text}`);
    });

    child.stderr.on('data', (chunk) => {
      const text = String(chunk);
      stderr += text;
      process.stderr.write(`[e2e] ${text}`);
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

async function run() {
  const endpoint =
    'node packages/gateway/dist/cli.js --config examples/gateway-basic/gateway-config.json --transport stdio';

  const listResult = await runCommand('node', [
    'packages/mcp-client/dist/cli.js',
    'tools',
    'list',
    '--transport',
    'stdio',
    '--endpoint',
    endpoint
  ]);

  if (!listResult.stdout.includes('local__echo')) {
    throw new Error(`expected local__echo in list output, got: ${listResult.stdout}`);
  }

  const callResult = await runCommand('node', [
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

  if (!callResult.stdout.includes('gateway-e2e')) {
    throw new Error(`expected gateway-e2e in call output, got: ${callResult.stdout}`);
  }

  process.stdout.write('gateway e2e passed\n');
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
