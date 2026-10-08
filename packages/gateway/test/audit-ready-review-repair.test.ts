import { expect, it } from 'vitest';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

it('an unavailable audit directory does not terminate Node before the first record or close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'audit-ready-review-'));
  const blocker = join(directory, 'file');
  await writeFile(blocker, 'not a directory');
  const child = fork(
    fileURLToPath(new URL('./fixtures/audit-ready-repair.ts', import.meta.url)),
    [join(blocker, 'audit.jsonl')],
    {
      execArgv: ['--import', createRequire(import.meta.url).resolve('tsx')],
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL('../tsconfig.json', import.meta.url))
      },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    }
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const messages: unknown[] = [];
  child.on('message', (message: unknown) => messages.push(message));
  try {
    const [code] = await once(child, 'exit');
    expect({ code, messages, stderr }).toMatchObject({
      code: 0,
      messages: [{ recordFailed: true, closeFailed: true }],
      stderr: ''
    });
  } finally {
    child.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
