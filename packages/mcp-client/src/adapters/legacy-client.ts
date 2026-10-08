import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

type SetProtocolVersionCapable = { setProtocolVersion(version: string): void };
type SessionIdCapable = { readonly sessionId?: string };

function hasSetProtocolVersion(
  transport: Transport
): transport is Transport & SetProtocolVersionCapable {
  return (
    typeof (transport as unknown as Partial<SetProtocolVersionCapable>).setProtocolVersion ===
    'function'
  );
}

function hasSessionId(transport: Transport): transport is Transport & SessionIdCapable {
  return 'sessionId' in transport;
}

/**
 * Thin public-interface wrapper that pins the initialize request body to a
 * requested protocol version. The negotiated version in the initialize
 * response still decides later headers (the SDK calls setProtocolVersion);
 * we never force an unnegotiated version onto the wire after the handshake.
 */
export function pinProtocolVersion(inner: Transport, version: string): Transport {
  const wrapper: Transport = {
    start: () => inner.start(),
    send: (message, options) => {
      const record = message as { method?: string };
      if (record.method === 'initialize') {
        const params = (message as { params?: Record<string, unknown> }).params ?? {};
        const patched = {
          ...(message as object),
          params: { ...params, protocolVersion: version }
        };
        return inner.send(patched as unknown as Parameters<Transport['send']>[0], options);
      }
      return inner.send(message, options);
    },
    close: () => inner.close()
  };

  // Delegate the SDK's settable callback slots through accessors so the
  // wrapped transport keeps receiving protocol-level lifecycle events.
  for (const key of ['onclose', 'onerror', 'onmessage'] as const) {
    Object.defineProperty(wrapper, key, {
      get: () => inner[key],
      set: (value) => {
        (inner as unknown as Record<string, unknown>)[key] = value;
      },
      enumerable: true,
      configurable: true
    });
  }

  if (hasSetProtocolVersion(inner)) {
    Object.assign(wrapper, {
      setProtocolVersion: (negotiated: string) => inner.setProtocolVersion(negotiated)
    });
  }
  if (hasSessionId(inner)) {
    Object.defineProperty(wrapper, 'sessionId', {
      get: () => (inner as Transport & SessionIdCapable).sessionId,
      enumerable: true,
      configurable: true
    });
  }
  if ('terminateSession' in inner && typeof inner.terminateSession === 'function') {
    const terminateSession = inner.terminateSession.bind(inner);
    Object.assign(wrapper, { terminateSession: () => terminateSession() });
  }
  return wrapper;
}
