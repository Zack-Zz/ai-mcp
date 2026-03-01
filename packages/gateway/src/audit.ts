import type { AuditEvent, AuditStore } from './types.js';

export class InMemoryAuditStore implements AuditStore {
  private readonly events: AuditEvent[] = [];

  public async record(event: AuditEvent): Promise<void> {
    this.events.push(event);
  }

  public list(): AuditEvent[] {
    return this.events.slice();
  }
}
