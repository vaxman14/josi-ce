import type { Task, TaskRun } from './api';

export type TaskTab = 'active' | 'waiting' | 'scheduled' | 'history';

const TERMINAL = new Set(['confirmed', 'failed', 'cancelled', 'closed']);
const WAITING = new Set(['awaiting_approval', 'awaiting_owner', 'held']);

export function tabForTask(task: Task, now = Date.now()): TaskTab {
  if (TERMINAL.has(task.state)) return 'history';
  if (task.next_wake_at && Date.parse(task.next_wake_at) > now) return 'scheduled';
  if (WAITING.has(task.state)) return 'waiting';
  return 'active';
}

export function tabForRun(run: TaskRun): TaskTab {
  return run.status === 'queued' || run.status === 'running' ? 'active' : 'history';
}

export function taskAction(task: Task): string {
  if (task.template_key === 'restaurant_reservation' && task.state === 'awaiting_owner') {
    return 'Waiting for you to finish the booking';
  }
  if (task.template_key === 'restaurant_reservation' && task.state === 'confirmed') {
    return 'Booking recorded from your confirmation';
  }
  const actions: Record<string, string> = {
    drafting: 'Working out the next steps',
    awaiting_approval: 'Waiting for your approval',
    ready: 'Ready for Josi to continue',
    attempting: 'Carrying out the task',
    held: task.next_wake_at ? 'Paused until the scheduled time' : 'Temporarily paused',
    awaiting_owner: 'Waiting for information from you',
    confirmed: 'Completed successfully',
    failed: task.fail_reason ? `Stopped: ${task.fail_reason}` : 'Could not complete the task',
    cancelled: 'Cancelled',
    closed: 'Finished',
  };
  return actions[task.state] ?? task.state.replace(/_/g, ' ');
}

const BOOKING_LINKS: Record<string, { origin: string; label: string }> = {
  open_table_url: { origin: 'https://www.opentable.com', label: 'Open OpenTable' },
  google_maps_url: { origin: 'https://www.google.com', label: 'Open Google Maps' },
};

export function taskSlotLink(key: string, value: unknown): { href: string; label: string } | null {
  const allowed = BOOKING_LINKS[key];
  if (!allowed || typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return url.origin === allowed.origin ? { href: url.toString(), label: allowed.label } : null;
  } catch {
    return null;
  }
}

export function runAction(run: TaskRun): string {
  if (run.status === 'queued') return 'Waiting for Josi to start';
  if (run.status === 'running') return 'Josi is working';
  if (run.status === 'completed') return 'Reply completed';
  return run.error_code ? `Stopped: ${run.error_code.replace(/_/g, ' ')}` : 'Could not finish';
}

export function canCancelTask(task: Task): boolean {
  return !TERMINAL.has(task.state);
}
