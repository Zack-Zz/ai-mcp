import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEvent, AuditStore } from './types.js';

export const DEFAULT_MAX_PENDING_EVENTS = 1024;

type QueuedEvent = {
  event: AuditEvent;
  settle: (error?: Error) => void;
};

export type JsonlAuditStoreOptions = {
  maxPendingEvents?: number;
  /** Test seam replacing the filesystem append. */
  sink?: (line: string) => Promise<void>;
};

/**
 * Bounded serial append queue. One complete JSON object per line; record()
 * resolves when that line is durably written. close() stops new events and
 * flushes the queue. Write failures reject their caller (surfaced upstream
 * as audit_unavailable with operationCompleted semantics).
 */
export class JsonlAuditStore implements AuditStore {
  private readonly queue: QueuedEvent[] = [];
  private readonly maxPendingEvents: number;
  private readonly sink: (line: string) => Promise<void>;
  private readonly ready: Promise<void>;
  private drainChain: Promise<void> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | undefined;

  public constructor(filePath: string, options: JsonlAuditStoreOptions = {}) {
    this.maxPendingEvents = options.maxPendingEvents ?? DEFAULT_MAX_PENDING_EVENTS;
    this.sink =
      options.sink ??
      (async (line: string) => {
        await appendFile(filePath, `${line}\n`, 'utf8');
      });
    this.ready = mkdir(dirname(filePath), { recursive: true }).then(() => undefined);
    // The store may be created before its first call. Observe an early
    // initialization failure immediately, while retaining the rejected
    // promise so record() and close() still report audit unavailability.
    void this.ready.catch(() => undefined);
  }

  public record(event: AuditEvent): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('Audit store is closed'));
    }
    if (this.queue.length >= this.maxPendingEvents) {
      return Promise.reject(
        Object.assign(new Error('Audit queue saturated'), { category: 'audit_unavailable' })
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.queue.push({
        event,
        settle: (error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        }
      });
      this.kick();
    });
  }

  public close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.kick();
    this.closePromise = (async () => {
      await this.drainChain;
      await this.ready;
    })();
    return this.closePromise;
  }

  private kick(): void {
    // Each kick chains one drain pass after the previous one; close awaits
    // the whole chain, so queued events flush before close resolves.
    this.drainChain = this.drainChain.then(() => this.drainOnce());
  }

  private async drainOnce(): Promise<void> {
    while (this.queue.length > 0) {
      const queued = this.queue.shift();
      if (!queued) {
        break;
      }
      try {
        await this.ready;
        await this.sink(JSON.stringify(queued.event));
        queued.settle();
      } catch (error) {
        queued.settle(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}
