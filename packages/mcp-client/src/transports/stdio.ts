import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mcpErrorSchema, type RpcResponse } from '@ai-mcp/shared';
import type { RpcTransport } from './base.js';

export class StdioTransport implements RpcTransport {
  private readonly child: ChildProcess;

  public constructor(command: string) {
    const [file, ...args] = command.split(' ').filter(Boolean);
    if (!file) {
      throw new Error(
        'A stdio endpoint command is required, e.g. "node dist/cli.js --transport stdio"'
      );
    }
    this.child = spawn(file, args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stderr?.on('data', (chunk) => {
      process.stderr.write(String(chunk));
    });
  }

  public async request(payload: unknown, timeoutMs: number): Promise<RpcResponse> {
    if (!this.child.stdin || !this.child.stdout) {
      throw new Error('stdio transport streams are not available');
    }

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);

    const outputPromise = once(this.child.stdout, 'data').then(([chunk]) => {
      const raw = String(chunk).trim();
      const data = JSON.parse(raw) as RpcResponse;
      if (data.error) {
        mcpErrorSchema.parse(data.error);
      }
      return data;
    });

    const timeoutPromise = new Promise<RpcResponse>((_, reject) => {
      setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([outputPromise, timeoutPromise]);
  }

  public async close(): Promise<void> {
    this.child.kill();
  }
}
