import { describe, expect, it } from 'vitest';
import { createLogRecord } from '../src/logging.js';

describe('logging helpers', () => {
  it('creates a log record with timestamp', () => {
    const record = createLogRecord({
      level: 'info',
      service: 'mcp-server',
      traceId: 'trace-1',
      message: 'started'
    });

    expect(record.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(record.service).toBe('mcp-server');
  });
});
