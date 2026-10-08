import { describe, expect, it } from 'vitest';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { McpClient } from '../src/client.js';
import { pinProtocolVersion } from '../src/adapters/legacy-client.js';

type SentMessage = {
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  id?: unknown;
};

function recordingTransport(): Transport & {
  sent: SentMessage[];
  setProtocolVersionCalls: string[];
  negotiated(version: string): void;
} {
  const sent: SentMessage[] = [];
  const setProtocolVersionCalls: string[] = [];
  const listeners = { onmessage: undefined as ((message: unknown) => void) | undefined };

  const transport = {
    sent,
    setProtocolVersionCalls,
    negotiated(version: string) {
      listeners.onmessage?.({
        jsonrpc: '2.0',
        id: transport.sent.find((message) => message.method === 'initialize')?.id ?? 1,
        result: {
          protocolVersion: version,
          capabilities: {},
          serverInfo: { name: 'fake', version: '0.0.1' }
        }
      });
    },
    start: async () => undefined,
    send: async (message: unknown) => {
      const record = message as SentMessage;
      sent.push(record);
      if (record.method === 'initialize') {
        // Answer the initialize request through the SDK's message callback.
        setTimeout(() => {
          listeners.onmessage?.({
            jsonrpc: '2.0',
            id: record.id,
            result: {
              protocolVersion: '2025-11-25',
              capabilities: {},
              serverInfo: { name: 'fake', version: '0.0.1' }
            }
          });
        }, 0);
      }
      if (record.method === 'notifications/initialized') {
        return;
      }
    },
    close: async () => undefined,
    set onmessage(handler: (message: unknown) => void) {
      listeners.onmessage = handler;
    },
    get onmessage() {
      return listeners.onmessage as (message: unknown) => void;
    },
    setProtocolVersion(version: string) {
      setProtocolVersionCalls.push(version);
    }
  } as unknown as Transport & {
    sent: SentMessage[];
    setProtocolVersionCalls: string[];
    negotiated(version: string): void;
  };
  return transport;
}

describe('protocol version pinning', () => {
  it('rewrites the initialize body to the requested version', async () => {
    const inner = recordingTransport();
    const pinned = pinProtocolVersion(inner, '2025-03-26');
    const client = new McpClient(pinned, 2000);
    await client.connect();

    const initialize = inner.sent.find((message) => message.method === 'initialize');
    expect(initialize?.params?.protocolVersion).toBe('2025-03-26');

    await client.close();
  });

  it('keeps the negotiated version from the response for later headers', async () => {
    const inner = recordingTransport();
    const pinned = pinProtocolVersion(inner, '2025-03-26');
    const client = new McpClient(pinned, 2000);
    await client.connect();

    // The fake server answers 2025-11-25; the client must adopt that value
    // for subsequent headers instead of forcing the requested version.
    expect(inner.setProtocolVersionCalls).toContain('2025-11-25');
    expect(inner.setProtocolVersionCalls).not.toContain('2025-03-26');

    await client.close();
  });

  it('leaves unpinned transports untouched', async () => {
    const inner = recordingTransport();
    const client = new McpClient(inner, 2000);
    await client.connect();

    const initialize = inner.sent.find((message) => message.method === 'initialize');
    expect(initialize?.params?.protocolVersion).toBe('2025-11-25');

    await client.close();
  });
});
