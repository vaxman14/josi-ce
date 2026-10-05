import { describe, expect, it } from 'vitest';
import type { Task, TaskRun } from '../src/lib/api';
import { canCancelTask, runAction, tabForRun, tabForTask, taskAction } from '../src/lib/taskManager';

const task = (state: string, extra: Partial<Task> = {}): Task => ({
  id: 't', template_key: 'follow_up', state, slots: {}, attempt_count: 0,
  next_wake_at: null, due_at: null, fail_reason: null,
  created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z', ...extra,
});

const run = (status: TaskRun['status']): TaskRun => ({
  id: 'r', thread_id: 'th', thread_title: 'Schedule with Sarah', status,
  attempt_of: null, error_code: null, error_retryable: null, started_at: null,
  completed_at: null, created_at: '2026-10-04T00:00:00Z', updated_at: '2026-10-04T00:00:00Z',
});

describe('task manager classification', () => {
  it('separates running, waiting, scheduled, and terminal tasks', () => {
    expect(tabForTask(task('attempting'))).toBe('active');
    expect(tabForTask(task('awaiting_owner'))).toBe('waiting');
    expect(tabForTask(task('held', { next_wake_at: '2099-01-01T00:00:00Z' }))).toBe('scheduled');
    expect(tabForTask(task('failed'))).toBe('history');
  });

  it('treats queued and running conversation work as active processes', () => {
    expect(tabForRun(run('queued'))).toBe('active');
    expect(tabForRun(run('running'))).toBe('active');
    expect(tabForRun(run('completed'))).toBe('history');
  });

  it('uses truthful action text and terminal controls', () => {
    expect(taskAction(task('awaiting_approval'))).toBe('Waiting for your approval');
    expect(runAction({ ...run('failed'), error_code: 'worker_interrupted' })).toContain('worker interrupted');
    expect(canCancelTask(task('ready'))).toBe(true);
    expect(canCancelTask(task('confirmed'))).toBe(false);
  });
});
