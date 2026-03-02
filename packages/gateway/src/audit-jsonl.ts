import { mkdir, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AuditEvent, AuditStore } from './types.js';

export class JsonlAuditStore implements AuditStore {
  private ready: Promise<void>;

  public constructor(private readonly filePath: string) {
    this.ready = mkdir(dirname(filePath), { recursive: true }).then(() => undefined);
  }

  public async record(event: AuditEvent): Promise<void> {
    await this.ready;
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}
