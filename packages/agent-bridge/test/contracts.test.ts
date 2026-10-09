import { describe, expect, it } from 'vitest';
import { parseStart, parseConfig } from '../src/contracts/validation.js';

const spec = {
  taskSpecVersion: '1',
  objective: 'Fix an explicitly delegated bug',
  acceptanceCriteria: ['Regression passes'],
  constraints: ['No Git delivery'],
  writeScope: ['src/**'],
  contextRefs: [],
  scopeReference: 'user-message:request-1',
  verificationIds: []
};
const args = { engine: 'claude-code', projectId: 'sample', requestId: 'request-1', taskSpec: spec };

describe('Bridge strict admission', () => {
  it('rejects a missing target before any execution', () => {
    expect(() => parseStart({ ...args, engine: undefined })).toThrowError(/TARGET_REQUIRED/);
  });
  it('accepts explicit canonical target and a bounded task spec', () => {
    expect(parseStart(args)).toMatchObject({
      engine: 'claude-code',
      workspacePolicy: 'isolated',
      taskSpec: spec
    });
  });
  it('rejects approval flags and arbitrary commands instead of treating them as user authorization', () => {
    expect(() => parseStart({ ...args, approved: true })).toThrowError(/INVALID_ARGUMENT/);
    expect(() => parseStart({ ...args, command: 'rm -rf arbitrary' })).toThrowError(
      /INVALID_ARGUMENT/
    );
  });
  it('rejects escaping write scope and unsupported demand versions', () => {
    expect(() =>
      parseStart({ ...args, taskSpec: { ...spec, writeScope: ['../other/**'] } })
    ).toThrowError(/INVALID_ARGUMENT/);
    expect(() =>
      parseStart({ ...args, taskSpec: { ...spec, taskSpecVersion: '99' } })
    ).toThrowError(/INVALID_ARGUMENT/);
  });
  it('does not accept bypass, shell commands or duplicate project identities in trusted configuration', () => {
    const cfg = {
      schemaVersion: 1,
      stateRoot: '/tmp/bridge-contract',
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { 'claude-code': { command: '/bin/claude', args: [] } },
      clients: [{ id: 'terminal', role: 'controller' }]
    };
    expect(parseConfig(cfg)).toMatchObject({
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }]
    });
    expect(() =>
      parseConfig({ ...cfg, projects: [...cfg.projects, ...cfg.projects] })
    ).toThrowError(/INVALID_CONFIG/);
    expect(() =>
      parseConfig({
        ...cfg,
        engines: { codex: { command: 'codex; curl example.com', permissionProfile: 'bypass' } }
      })
    ).toThrowError(/INVALID_CONFIG/);
  });
  it('makes the Codex session transport explicit in normalized configuration so previous exec evidence cannot describe the new default', () => {
    const cfg = {
      schemaVersion: 1,
      stateRoot: '/tmp/bridge-contract',
      projects: [{ id: 'sample', repoRoot: '/tmp/sample' }],
      engines: { codex: { command: '/bin/codex' } },
      clients: [{ id: 'terminal', role: 'controller' }]
    };
    expect(parseConfig(cfg).engines.codex).toMatchObject({ codexTransport: 'app-server' });
    expect(
      parseConfig({ ...cfg, engines: { codex: { command: '/bin/codex', codexTransport: 'exec' } } })
        .engines.codex
    ).toMatchObject({ codexTransport: 'exec' });
    expect(() =>
      parseConfig({
        ...cfg,
        engines: { 'claude-code': { command: '/bin/claude', codexTransport: 'app-server' } }
      })
    ).toThrowError(/INVALID_CONFIG/);
  });
});
