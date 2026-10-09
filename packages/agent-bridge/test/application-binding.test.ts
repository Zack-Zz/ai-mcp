import { describe, expect, it } from 'vitest';
import type { TaskRecord } from '../src/contracts/types.js';
import { harness, pause } from './application-harness.js';

describe('Failed task binding and continuation', () => {
  it('queries failed tasks successfully and continues only their exact recorded session', async () => {
    const h = await harness();
    try {
      const task = (await h.app.dispatch('origin', 'task.start', h.args)) as TaskRecord;
      for (let i = 0; h.launches() === 0 && i < 100; i++) await pause();
      h.outcomes[0]?.({
        status: 'failed',
        sessionId: '11111111-1111-4111-8111-111111111111',
        message: 'Failure',
        exitCode: 1,
        executionDisposition: 'unknown'
      });
      await h.app.idle();
      expect(
        ((await h.app.dispatch('origin', 'task.get', { taskId: task.taskId })) as TaskRecord).state
      ).toBe('failed');
      await expect(
        h.app.dispatch('origin', 'task.continue', {
          taskId: task.taskId,
          requestId: 'next',
          message: 'Fix',
          engine: 'zcode'
        })
      ).rejects.toThrow(/INVALID_ARGUMENT|STATE_CONFLICT/);
      await h.app.dispatch('origin', 'task.continue', {
        taskId: task.taskId,
        requestId: 'next',
        message: 'Fix the original criteria'
      });
      for (let i = 0; h.launches() < 2 && i < 100; i++) await pause();
      expect(h.launches()).toBe(2);
    } finally {
      await h.cleanup();
    }
  });
  it('binds an existing workspace lease and cancellation to the original task', async () => {
    const h = await harness();
    try {
      const task = (await h.app.dispatch('origin', 'task.start', {
        ...h.args,
        workspacePolicy: 'existing'
      })) as TaskRecord;
      await expect(
        h.app.dispatch('origin', 'task.start', {
          ...h.args,
          requestId: 'second',
          workspacePolicy: 'existing'
        })
      ).rejects.toThrow(/WORKSPACE_BUSY/);
      await h.app.dispatch('origin', 'task.cancel', { taskId: task.taskId, requestId: 'cancel' });
      await h.app.idle();
      expect(
        ((await h.app.dispatch('origin', 'task.get', { taskId: task.taskId })) as TaskRecord).state
      ).toBe('cancelled');
    } finally {
      await h.cleanup();
    }
  });
});
