import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { EngineEvent } from '../contracts/types.js';
import { BridgeError } from '../contracts/errors.js';
import { stateDirectory } from '../workspaces/paths.js';
import { assertPrivate } from '../client/security.js';
import { atomicWrite } from './journal.js';

/** Sanitized events are durable while the native run is still active. */
export class RunLog {
  private queue: Promise<void> = Promise.resolve();
  private size = 0;
  private constructor(
    private readonly root: string,
    private readonly limit: number
  ) {}
  public static async open(
    stateRoot: string,
    taskId: string,
    runId: string,
    limit: number
  ): Promise<RunLog> {
    const root = await stateDirectory(stateRoot, 'tasks', taskId, 'runs', runId);
    const log = new RunLog(root, limit);
    for (const name of ['stdout.jsonl', 'stderr.log']) {
      const file = await open(
        join(root, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      );
      try {
        assertPrivate(await file.stat(), 'file');
        await file.sync();
      } finally {
        await file.close();
      }
    }
    return log;
  }
  public append(event: EngineEvent): Promise<void> {
    const line = JSON.stringify(event) + '\n';
    const bytes = Buffer.byteLength(line);
    const operation = this.queue.then(async () => {
      if (this.size + bytes > this.limit)
        throw new BridgeError(
          'OUTPUT_LIMIT',
          'Sanitized run log exceeds its configured limit',
          'unknown'
        );
      const path = join(this.root, event.kind === 'diagnostic' ? 'stderr.log' : 'stdout.jsonl');
      const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        assertPrivate(await file.stat(), 'file');
        await file.writeFile(line);
        await file.sync();
        this.size += bytes;
      } finally {
        await file.close();
      }
    });
    this.queue = operation;
    return operation;
  }
  public async flush(): Promise<void> {
    await this.queue;
  }
  public async outcome(value: unknown): Promise<void> {
    await this.flush();
    await atomicWrite(join(this.root, 'outcome.json'), JSON.stringify(value) + '\n');
  }
  public static async read(
    stateRoot: string,
    taskId: string,
    runId: string
  ): Promise<{ stdout: string; stderr: string }> {
    const root = await stateDirectory(stateRoot, 'tasks', taskId, 'runs', runId);
    const read = async (name: string) => {
      let file;
      try {
        file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
        throw error;
      }
      try {
        const stat = await file.stat();
        assertPrivate(stat, 'file');
        if (stat.size > 67108864)
          throw new BridgeError('OUTPUT_LIMIT', 'Persisted run log exceeds its limit', 'unknown');
        return await file.readFile('utf8');
      } finally {
        await file.close();
      }
    };
    return { stdout: await read('stdout.jsonl'), stderr: await read('stderr.log') };
  }
}
