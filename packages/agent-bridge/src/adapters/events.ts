import type { EngineEvent, JsonValue } from '../contracts/types.js';
import type { EngineId } from '../contracts/validation.js';

type Frame = Record<string, unknown>;
function record(value: unknown): Frame {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Frame)
    : {};
}
function string(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
export function scrubText(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets)
    if (secret.length >= 4) safe = safe.split(secret).join('[REDACTED]');
  return safe
    .replace(/(authorization\s*:\s*(?:bearer\s+)?)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|password|secret)\s*[=:]\s*["']?)[^\s,"';}]+/gi,
      '$1[REDACTED]'
    )
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}
export function scrub(value: unknown, secrets: readonly string[]): JsonValue {
  if (typeof value === 'string') return scrubText(value, secrets);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((item) => scrub(item, secrets));
  return Object.fromEntries(
    Object.entries(record(value))
      .filter(
        ([key]) =>
          !/key|password|secret|authorization|cookie|credential|^(?:token|access.?token|refresh.?token|id.?token|session.?token)$/i.test(
            key
          )
      )
      .map(([key, entry]) => [key, scrub(entry, secrets)])
  );
}

export class EventDecoder {
  sessionId?: string;
  terminal = false;
  invalid = false;
  failed = false;
  message = '';
  usage?: JsonValue;
  constructor(
    private readonly engine: EngineId,
    private readonly expected: string | undefined,
    private readonly secrets: readonly string[],
    private readonly observe: (event: EngineEvent) => void
  ) {}

  emit(kind: EngineEvent['kind'], data: unknown): void {
    try {
      this.observe({ kind, data: scrub(data, this.secrets) });
    } catch {
      this.invalid = true;
      this.failed = true;
    }
  }
  parse(line: string): void {
    if (!line.trim()) return;
    let frame: Frame;
    try {
      const parsed: unknown = JSON.parse(line);
      frame = record(parsed);
      if (!Object.keys(frame).length) throw new Error();
    } catch {
      this.invalid = true;
      this.emit('diagnostic', { message: 'Invalid native JSON frame' });
      return;
    }
    if (this.engine === 'claude-code') this.claude(frame);
    else if (this.engine === 'codex') this.codex(frame);
    else this.zcode(frame);
  }
  private session(value: unknown): void {
    const id = string(value);
    const valid =
      this.engine === 'zcode'
        ? /^sess_[A-Za-z0-9_-]+$/.test(id)
        : /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
    if (
      !valid ||
      (this.expected && id !== this.expected) ||
      (this.sessionId && id !== this.sessionId)
    ) {
      this.invalid = true;
      return;
    }
    this.sessionId = id;
    this.emit('session', { sessionId: id });
  }
  private text(value: unknown): void {
    if (typeof value !== 'string') return;
    this.message = scrubText(value, this.secrets);
    this.emit('message', { text: this.message });
  }
  private consumed(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    this.usage = scrub(value, this.secrets);
    this.emit('usage', this.usage);
  }
  private claude(frame: Frame): void {
    if (frame.session_id !== undefined) this.session(frame.session_id);
    if (frame.type === 'assistant') {
      const content = record(frame.message).content;
      if (Array.isArray(content))
        for (const part of content) {
          const item = record(part);
          if (item.type === 'text') this.text(item.text);
          if (item.type === 'tool_use')
            this.emit('tool', { name: string(item.name), status: 'requested' });
        }
    }
    if (frame.type === 'result') {
      this.terminal = frame.subtype === 'success' && frame.is_error === false;
      this.failed = !this.terminal;
      this.text(frame.result);
      this.consumed(frame.usage);
    }
  }
  private codex(frame: Frame): void {
    if (frame.type === 'thread.started') this.session(frame.thread_id);
    if (frame.type === 'item.completed' || frame.type === 'item.started') {
      const item = record(frame.item);
      if (item.type === 'agent_message') this.text(item.text);
      else if (typeof item.type === 'string')
        this.emit('tool', { name: item.type, status: string(frame.type) });
    }
    if (frame.type === 'turn.completed') {
      this.terminal = true;
      this.consumed(frame.usage);
    }
    if (frame.type === 'turn.failed' || frame.type === 'error') {
      this.failed = true;
      this.emit('diagnostic', { message: 'Native engine reported failure' });
    }
  }
  private zcode(frame: Frame): void {
    if (frame.type !== 'result') return;
    this.session(frame.sessionId);
    this.text(frame.response);
    this.consumed(frame.usage);
    const status = record(frame.projection).status;
    this.terminal =
      typeof frame.response === 'string' &&
      frame.is_error !== true &&
      (status === 'idle' || status === 'completed');
    this.failed = !this.terminal;
  }
}
