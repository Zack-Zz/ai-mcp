// Shared helpers for gateway e2e scripts: process spawning, readiness waits,
// and raw JSON-RPC-over-HTTP utilities that expose exact wire details.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import process from 'node:process';

export function spawnLongRunning(command, args, label) {
  const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    output.stdout += text;
    process.stdout.write(`[${label}] ${text}`);
  });
  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    output.stderr += text;
    process.stderr.write(`[${label}] ${text}`);
  });
  child.output = output;
  return child;
}

export function waitForReady(processRef, readyPattern, label) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`${label} did not become ready within timeout`));
    }, 20_000);
    const cleanup = () => {
      clearTimeout(timeout);
      processRef.stderr.off('data', onStderr);
      processRef.off('exit', onExit);
      processRef.off('error', onError);
    };
    const onStderr = (chunk) => {
      if (readyPattern.test(String(chunk))) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error(`${label} exited before ready (code=${code ?? 'null'})`));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    processRef.stderr.on('data', onStderr);
    processRef.on('exit', onExit);
    processRef.on('error', onError);
  });
}

export function runCommand(command, args, options = {}) {
  const expectFailure = options.expectFailure ?? false;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('close', (code) => {
      if (code !== 0 && !expectFailure) {
        reject(new Error(`command failed (${command} ${args.join(' ')}): ${stderr}`));
        return;
      }
      if (code === 0 && expectFailure) {
        reject(new Error(`expected failure but succeeded: ${command} ${args.join(' ')}`));
        return;
      }
      resolve({ stdout, stderr, code });
    });
  });
}

export function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate free port')));
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
    server.on('error', reject);
  });
}

export function canBindPort(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

/** Raw JSON-RPC POST returning status, headers and parsed body. */
export async function rpcPost(endpoint, payload, headers = {}, sessionId) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...headers
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let body = null;
  const contentType = String(response.headers.get('content-type') ?? '');
  if (contentType.includes('text/event-stream')) {
    // Streamable HTTP may answer JSON-RPC over SSE; take the last data line.
    const dataLines = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    for (const line of dataLines.reverse()) {
      try {
        body = JSON.parse(line);
        break;
      } catch {
        // try next line
      }
    }
  } else {
    try {
      body = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }
  }
  return {
    status: response.status,
    headers: response.headers,
    body,
    sessionId: response.headers.get('mcp-session-id')
  };
}

/** Minimal stateful client over raw fetch: initialize + call + close. */
export async function openSession(endpoint, { protocolVersion, meta } = {}) {
  const init = await rpcPost(endpoint, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: protocolVersion ?? '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'e2e-raw', version: '0.0.1' }
    }
  });
  if (init.status !== 200 || !init.sessionId) {
    throw new Error(`initialize failed: ${init.status} ${JSON.stringify(init.body)}`);
  }
  const negotiated = init.body?.result?.protocolVersion;
  await rpcPost(
    endpoint,
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {},
    init.sessionId
  );
  return {
    sessionId: init.sessionId,
    negotiated,
    callId: 1,
    async call(toolName, args, callMeta) {
      this.callId += 1;
      const id = this.callId;
      const result = await rpcPost(
        endpoint,
        {
          jsonrpc: '2.0',
          id,
          method: 'tools/call',
          params: {
            name: toolName,
            arguments: args,
            ...(callMeta ? { _meta: callMeta } : {})
          }
        },
        negotiated ? { 'mcp-protocol-version': negotiated } : {},
        init.sessionId
      );
      return { id, ...result };
    },
    async close() {
      await fetch(endpoint, {
        method: 'DELETE',
        headers: {
          accept: 'application/json, text/event-stream',
          ...(init.sessionId ? { 'mcp-session-id': init.sessionId } : {})
        }
      }).catch(() => undefined);
    }
  };
}

export async function stopProcess(child, label) {
  if (!child || child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  clearTimeout(timeout);
  void label;
}

export function assert(condition, message) {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`);
  }
}
