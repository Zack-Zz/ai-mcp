import { describe, expect, it } from 'vitest';
import {
  ERROR_CATEGORIES,
  PROJECT_ERROR_CODES,
  categoryForCode,
  createFault,
  isInvocationFault
} from '../src/invocation.js';

describe('error categories', () => {
  it('exposes the closed category set required by the design', () => {
    for (const category of [
      'invalid_request',
      'invalid_params',
      'tool_failure',
      'policy_denied',
      'rate_limited',
      'backend_timeout',
      'backend_unavailable',
      'invalid_result',
      'cancelled',
      'audit_unavailable',
      'internal',
      'unsupported_capability'
    ]) {
      expect(ERROR_CATEGORIES).toContain(category);
    }
  });

  it('maps project codes onto stable categories', () => {
    expect(categoryForCode('INVALID_PARAMS')).toBe('invalid_params');
    expect(categoryForCode('TOOL_FAILED')).toBe('tool_failure');
    expect(categoryForCode('POLICY_DENIED')).toBe('policy_denied');
    expect(categoryForCode('RATE_LIMITED')).toBe('rate_limited');
    expect(categoryForCode('BACKEND_TIMEOUT')).toBe('backend_timeout');
    expect(categoryForCode('BACKEND_UNAVAILABLE')).toBe('backend_unavailable');
    expect(categoryForCode('INVALID_RESULT')).toBe('invalid_result');
    expect(categoryForCode('CANCELLED')).toBe('cancelled');
    expect(categoryForCode('AUDIT_UNAVAILABLE')).toBe('audit_unavailable');
    expect(categoryForCode('UNSUPPORTED_CAPABILITY')).toBe('unsupported_capability');
    expect(categoryForCode('INTERNAL')).toBe('internal');
    expect(() => categoryForCode('NOT_A_CODE')).toThrow();
  });

  it('keeps the four legacy string codes on the project code set', () => {
    for (const legacy of ['INVALID_PARAMS', 'UNAUTHORIZED', 'TIMEOUT', 'INTERNAL']) {
      expect(PROJECT_ERROR_CODES).toContain(legacy);
    }
    expect(categoryForCode('UNAUTHORIZED')).toBe('policy_denied');
    expect(categoryForCode('TIMEOUT')).toBe('backend_timeout');
  });
});

describe('invocation fault', () => {
  it('creates a fault with trace/invocation identity and execution disposition', () => {
    const fault = createFault({
      category: 'backend_timeout',
      projectCode: 'BACKEND_TIMEOUT',
      message: 'downstream deadline exceeded',
      traceId: 'trace-1',
      invocationId: 'inv-1',
      executionDisposition: 'unknown',
      source: { kind: 'peer', backendId: 'catalog', protocolVersion: '2025-03-26' }
    });

    expect(fault.category).toBe('backend_timeout');
    expect(fault.traceId).toBe('trace-1');
    expect(fault.invocationId).toBe('inv-1');
    expect(fault.executionDisposition).toBe('unknown');
    expect(fault.source?.backendId).toBe('catalog');
    expect(isInvocationFault(fault)).toBe(true);
  });

  it('rejects unknown categories at parse time', () => {
    expect(isInvocationFault({ category: 'nope', projectCode: 'X' })).toBe(false);
  });
});
