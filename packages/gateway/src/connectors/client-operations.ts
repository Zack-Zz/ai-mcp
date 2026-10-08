import type { McpClient } from '@ai-mcp/mcp-client';

/** Retirement waits for admitted operations; service shutdown can still close immediately. */
export class ClientOperations {
  private readonly clients = new Map<
    McpClient,
    { count: number; idle: Promise<void>; resolve: () => void }
  >();

  public acquire(client: McpClient): () => void {
    let active = this.clients.get(client);
    if (!active) {
      let resolve!: () => void;
      const idle = new Promise<void>((done) => {
        resolve = done;
      });
      active = { count: 0, idle, resolve };
      this.clients.set(client, active);
    }
    active.count++;
    const acquired = active;
    return () => {
      if (--acquired.count === 0) {
        this.clients.delete(client);
        acquired.resolve();
      }
    };
  }

  public waitForIdle(client: McpClient): Promise<void> {
    return this.clients.get(client)?.idle ?? Promise.resolve();
  }
}
