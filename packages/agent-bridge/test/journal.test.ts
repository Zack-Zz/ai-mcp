import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/runtime/journal.js';

describe('Durable single-writer history', () => {
  it('refuses state directories or committed files readable by other local users', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-journal-'));
    try {
      await chmod(root, 0o777);
      await expect(Journal.open(root)).rejects.toThrow(/STATE_UNSAFE/);
      await chmod(root, 0o700);
      const journal = await Journal.open(root);
      await journal.append('sample', {});
      await chmod(join(root, 'events.jsonl'), 0o644);
      await expect(journal.append('sample', {})).rejects.toThrow(/STATE_UNSAFE/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('serializes concurrent writes, survives reopen and binds each entry to its predecessor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-journal-'));
    try {
      const journal = await Journal.open(root);
      await Promise.all(
        Array.from({ length: 20 }, (_, index) => journal.append('sample', { index }))
      );
      const reopened = await Journal.open(root);
      expect(reopened.records).toHaveLength(20);
      expect(reopened.records.map((entry) => entry.sequence)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 1)
      );
      expect(reopened.records[19]?.data).toEqual({ index: 19 });
      expect((await readFile(join(root, 'events.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(
        20
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('preserves a truncated tail as evidence, but refuses corruption in committed history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-journal-'));
    try {
      const journal = await Journal.open(root);
      await journal.append('sample', { index: 1 });
      const committed = await readFile(join(root, 'events.jsonl'), 'utf8');
      await writeFile(join(root, 'events.jsonl'), committed + '{"unfinished":');
      const reopened = await Journal.open(root);
      expect(reopened.records).toHaveLength(1);
      expect(reopened.recoveredTail).toBeTruthy();
      expect(await readFile(reopened.recoveredTail!, 'utf8')).toBe('{"unfinished":');
      const changed = JSON.parse(committed) as { data: { index: number } };
      changed.data.index = 9;
      await writeFile(join(root, 'events.jsonl'), JSON.stringify(changed) + '\n');
      await expect(Journal.open(root)).rejects.toThrow(/STATE_CORRUPT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('refuses a symlinked state file rather than appending outside the owned state root', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-journal-'));
    try {
      const outside = join(root, 'outside');
      await writeFile(outside, 'original');
      await symlink(outside, join(root, 'events.jsonl'));
      await expect(Journal.open(root)).rejects.toThrow(/STATE_UNSAFE/);
      expect(await readFile(outside, 'utf8')).toBe('original');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
