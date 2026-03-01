export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogRecord = {
  timestamp: string;
  level: LogLevel;
  service: 'mcp-server' | 'mcp-client';
  traceId: string;
  message: string;
  meta?: Record<string, unknown>;
};

export function createLogRecord(input: Omit<LogRecord, 'timestamp'>): LogRecord {
  return {
    ...input,
    timestamp: new Date().toISOString()
  };
}
