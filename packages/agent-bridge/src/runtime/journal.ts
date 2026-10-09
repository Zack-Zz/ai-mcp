import { createHash, randomUUID } from 'node:crypto';
import { mkdir, lstat, readFile, writeFile, open, rename, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { constants, type Stats } from 'node:fs';
import { BridgeError } from '../contracts/errors.js';

export type JournalRecord = {
  sequence: number;
  type: string;
  data: unknown;
  timestamp: string;
  hash: string;
  previous: string;
};
export function canonical(value: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(value));
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, entry]) => [key, sorted(entry)])
      );
    return item;
  };
  return JSON.stringify(sorted(normalized));
}
export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export async function assertOwnedFile(path: string): Promise<void> {
  try {
    const stat = await lstat(path);
    assertPrivate(stat, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
function assertPrivate(stat: Stats, directory: boolean): void {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new BridgeError('STATE_UNSAFE', 'State must be private and owned by the current user');
}
export async function atomicWrite(path: string, content: string): Promise<void> {
  await assertOwnedFile(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(content);
    await file.sync();
    await file.close();
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
export class Journal {
  private queue: Promise<unknown> = Promise.resolve();
  public readonly records: JournalRecord[] = [];
  public recoveredTail: string | undefined;
  private constructor(private readonly root: string) {}

  public static async open(root: string): Promise<Journal> {
    try {
      const stat = await lstat(root);
      assertPrivate(stat, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await mkdir(root, { recursive: true, mode: 0o700 });
    assertPrivate(await lstat(root), true);
    const journal = new Journal(root);
    const path = join(root, 'events.jsonl');
    await assertOwnedFile(path);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      content = '';
    }
    if (content && !content.endsWith('\n')) {
      const end = content.lastIndexOf('\n') + 1;
      journal.recoveredTail = join(root, `events.truncated-${randomUUID()}.json`);
      await writeFile(journal.recoveredTail, content.slice(end), { flag: 'wx', mode: 0o600 });
      content = content.slice(0, end);
      await atomicWrite(path, content);
    }
    let previous = '0'.repeat(64);
    for (const line of content.split('\n').filter(Boolean)) {
      let record: JournalRecord;
      try {
        record = JSON.parse(line) as JournalRecord;
      } catch {
        throw new BridgeError('STATE_CORRUPT', 'Invalid committed event JSON');
      }
      const { hash, ...body } = record;
      if (
        record.sequence !== journal.records.length + 1 ||
        record.previous !== previous ||
        typeof record.type !== 'string' ||
        typeof record.timestamp !== 'string' ||
        hash !== digest(body)
      )
        throw new BridgeError('STATE_CORRUPT', 'Event sequence or hash chain is invalid');
      journal.records.push(record);
      previous = hash;
    }
    return journal;
  }

  public append(type: string, data: unknown): Promise<JournalRecord> {
    const operation = this.queue.then(async () => {
      const body = {
        sequence: this.records.length + 1,
        type,
        data: JSON.parse(JSON.stringify(data)) as unknown,
        timestamp: new Date().toISOString(),
        previous: this.records.at(-1)?.hash ?? '0'.repeat(64)
      };
      const record = { ...body, hash: digest(body) };
      const path = join(this.root, 'events.jsonl');
      await assertOwnedFile(path);
      let file;
      try {
        file = await open(
          path,
          constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
          0o600
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOOP')
          throw new BridgeError('STATE_UNSAFE', 'Symlink state file rejected');
        throw error;
      }
      try {
        assertPrivate(await file.stat(), false);
        await file.writeFile(canonical(record) + '\n');
        await file.sync();
      } finally {
        await file.close();
      }
      this.records.push(record);
      return record;
    });
    this.queue = operation;
    return operation;
  }
  public async flush(): Promise<void> {
    await this.queue;
  }
}
