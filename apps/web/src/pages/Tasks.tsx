// A process manager for everything Josi is doing, waiting on, scheduling, or
// recently finished. This is intentionally not a second to-do list.
import { useEffect, useMemo, useState } from 'react';
import { api, type Reminder, type Task, type TaskActivity, type TaskRun, type TaskType } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, Input } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';
import { canCancelTask, runAction, tabForRun, tabForTask, taskAction, type TaskTab } from '@/lib/taskManager';

const TABS: Array<{ key: TaskTab; label: string }> = [
  { key: 'active', label: 'Active' },
  { key: 'waiting', label: 'Waiting' },
  { key: 'scheduled', label: 'Scheduled' },
  { key: 'history', label: 'History' },
];

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function elapsed(from: string, to = Date.now()): string {
  const seconds = Math.max(0, Math.floor((to - Date.parse(from)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

function taskTone(state: string): 'muted' | 'primary' | 'danger' | 'ok' {
  if (state === 'failed') return 'danger';
  if (state === 'confirmed' || state === 'closed') return 'ok';
  if (state === 'attempting' || state === 'ready') return 'primary';
  return 'muted';
}

function eventLabel(kind: string, payload: Record<string, unknown>): string {
  if (kind === 'task.created') return 'Task created';
  if (kind === 'task.transition') {
    const to = typeof payload.to === 'string' ? plain('task_state', payload.to) : 'a new state';
    return `Status changed to ${to}`;
  }
  if (kind === 'task.slots_updated') return 'Task details updated';
  return kind.replace(/^task\./, '').replace(/[._]/g, ' ');
}

type TimelineRow = { id: string; at: string; label: string; detail?: string };

function timeline(activity: TaskActivity): TimelineRow[] {
  const events = activity.events
    .filter((event) => event.kind !== 'task.attempt' && !event.kind.startsWith('approval.'))
    .map((event) => ({ id: `event-${event.id}`, at: event.created_at, label: eventLabel(event.kind, event.payload) }));
  const attempts = activity.attempts.map((attempt) => ({
    id: `attempt-${attempt.id}`,
    at: attempt.ended_at ?? attempt.started_at,
    label: attempt.outcome ? `${attempt.kind.replace(/_/g, ' ')}: ${attempt.outcome.replace(/_/g, ' ')}` : attempt.kind.replace(/_/g, ' '),
  }));
  const approvals = activity.approvals.map((approval) => ({
    id: `approval-${approval.id}`,
    at: approval.decided_at ?? approval.created_at,
    label: `Approval ${approval.status.replace(/_/g, ' ')}`,
    detail: approval.summary,
  }));
  return [...events, ...attempts, ...approvals].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function Tasks() {
  const [tab, setTab] = useState<TaskTab>('active');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<TaskRun[]>([]);
  const [upcoming, setUpcoming] = useState<Reminder[]>([]);
  const [recent, setRecent] = useState<Reminder[]>([]);
  const [types, setTypes] = useState<TaskType[]>([]);
  const [templateKey, setTemplateKey] = useState('');
  const [openTask, setOpenTask] = useState<string | null>(null);
  const [activities, setActivities] = useState<Record<string, TaskActivity>>({});
  const [approvalPassword, setApprovalPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    try {
      const [taskResult, runResult, reminderResult] = await Promise.all([
        api.get<{ tasks: Task[] }>('/assistant/tasks?all=1'),
        api.get<{ runs: TaskRun[] }>('/assistant/task-runs'),
        api.get<{ upcoming: Reminder[]; recent: Reminder[] }>('/assistant/reminders'),
      ]);
      setTasks(taskResult.tasks);
      setRuns(runResult.runs);
      setUpcoming(reminderResult.upcoming);
      setRecent(reminderResult.recent);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh task activity');
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    void api.get<{ types: TaskType[] }>('/assistant/task-types').then((result) => {
      setTypes(result.types);
      setTemplateKey(result.types[0]?.key ?? '');
    }).catch(() => undefined);
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, []);

  // The expanded timeline is live too. A task manager that updates its count
  // while leaving the open process log stale would be a particularly petty bug.
  useEffect(() => {
    if (!openTask) return undefined;
    const refresh = () => void api.get<{ activity: TaskActivity }>(`/assistant/tasks/${openTask}/activity`)
      .then((result) => setActivities((current) => ({ ...current, [openTask]: result.activity })))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not refresh task history'));
    refresh();
    const timer = window.setInterval(refresh, 3000);
    return () => window.clearInterval(timer);
  }, [openTask]);

  const counts = useMemo(() => ({
    active: tasks.filter((task) => tabForTask(task) === 'active').length + runs.filter((run) => tabForRun(run) === 'active').length,
    waiting: tasks.filter((task) => tabForTask(task) === 'waiting').length,
    scheduled: tasks.filter((task) => tabForTask(task) === 'scheduled').length + upcoming.length,
    history: tasks.filter((task) => tabForTask(task) === 'history').length + runs.filter((run) => tabForRun(run) === 'history').length + recent.length,
  }), [tasks, runs, upcoming, recent]);

  const visibleTasks = tasks.filter((task) => tabForTask(task) === tab);
  const visibleRuns = runs.filter((run) => tabForRun(run) === tab);
  const visibleReminders = tab === 'scheduled' ? upcoming : tab === 'history' ? recent : [];
  const selected = types.find((type) => type.key === templateKey);
  const names = new Map(types.map((type) => [type.key, type.name]));

  function toggleTask(id: string) {
    if (openTask === id) { setOpenTask(null); return; }
    setOpenTask(id);
  }

  async function cancelTask(task: Task) {
    if (!window.confirm('Cancel this task? Josi will stop future work on it.')) return;
    setBusy(true); setError('');
    try {
      await api.patch(`/assistant/tasks/${task.id}`, { state: 'cancelled' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel that task');
    } finally { setBusy(false); }
  }

  async function approveTask(id: string) {
    setBusy(true); setError('');
    try {
      await api.post('/assistant/step-up', { password: approvalPassword });
      await api.patch(`/assistant/tasks/${id}`, { state: 'ready' });
      setApprovalPassword('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not approve that task');
    } finally { setBusy(false); }
  }

  async function cancelReminder(id: string) {
    setBusy(true); setError('');
    try {
      await api.post(`/assistant/reminders/${id}/cancel`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel that reminder');
    } finally { setBusy(false); }
  }

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected) return;
    setBusy(true); setError('');
    const form = new FormData(event.currentTarget);
    const slots: Record<string, string> = {};
    for (const key of selected.contract.slots.required) slots[key] = String(form.get(key) ?? '');
    try {
      await api.post('/assistant/tasks', { templateKey, slots });
      event.currentTarget.reset();
      setTab('active');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create that task');
    } finally { setBusy(false); }
  }

  const empty = visibleTasks.length === 0 && visibleRuns.length === 0 && visibleReminders.length === 0;

  return (
    <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Tasks</h1>
        <p className="mt-1 text-sm text-muted-foreground">Everything Josi is doing, waiting on, or has scheduled for you.</p>
      </div>

      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" aria-label="Task status summary">
        {TABS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setTab(item.key)}
            aria-pressed={tab === item.key}
            className={`min-h-16 rounded-lg border p-3 text-left transition-colors ${tab === item.key ? 'border-primary bg-primary/10' : 'border-border bg-card hover:bg-secondary/60'}`}
          >
            <span className="block text-xs text-muted-foreground">{item.label}</span>
            <span className="mt-1 block text-xl font-semibold tabular-nums">{counts[item.key]}</span>
          </button>
        ))}
      </div>

      {empty ? (
        <Empty title={loaded ? `Nothing ${tab}` : 'Loading task activity…'}>
          {loaded && tab === 'active' ? 'Josi is not working on anything right now.' : undefined}
        </Empty>
      ) : (
        <div className="space-y-3" aria-live="polite">
          {visibleRuns.map((run) => (
            <Card key={`run-${run.id}`} className={run.status === 'running' ? 'border-primary/60' : undefined}>
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="min-w-0 truncate font-medium">{run.thread_title ?? 'Conversation task'}</p>
                    <Badge tone={run.status === 'failed' ? 'danger' : run.status === 'completed' ? 'ok' : 'primary'}>
                      {run.status === 'queued' ? 'Queued' : run.status === 'running' ? 'Working' : run.status === 'completed' ? 'Completed' : 'Failed'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">{runAction(run)}</p>
                </div>
                <Badge tone="muted">Conversation</Badge>
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Started {when(run.started_at ?? run.created_at)} · {run.completed_at ? `Finished ${when(run.completed_at)}` : `Running ${elapsed(run.started_at ?? run.created_at)}`}
              </p>
            </Card>
          ))}

          {visibleTasks.map((task) => {
            const activity = activities[task.id];
            return (
              <Card key={`task-${task.id}`} className={task.state === 'attempting' ? 'border-primary/60' : undefined}>
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 truncate font-medium">{names.get(task.template_key) ?? task.template_key.replace(/_/g, ' ')}</p>
                      <Badge tone={taskTone(task.state)}>{plain('task_state', task.state)}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-muted-foreground">{taskAction(task)}</p>
                  </div>
                  <Badge tone="muted">Background task</Badge>
                </div>

                {task.next_wake_at && tab === 'scheduled' ? <p className="mt-2 text-sm">Continues {when(task.next_wake_at)}</p> : null}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button type="button" variant="secondary" onClick={() => toggleTask(task.id)} aria-expanded={openTask === task.id}>
                    {openTask === task.id ? 'Hide details' : 'Details'}
                  </Button>
                  {canCancelTask(task) ? (
                    <Button type="button" variant="ghost" disabled={busy} onClick={() => void cancelTask(task)}>Cancel</Button>
                  ) : null}
                </div>

                {openTask === task.id ? (
                  <div className="mt-4 border-t border-border pt-4">
                    {Object.keys(task.slots).length ? (
                      <dl className="mb-4 space-y-1 text-sm">
                        {Object.entries(task.slots).map(([key, value]) => (
                          <div key={key} className="flex min-w-0 gap-2">
                            <dt className="shrink-0 text-muted-foreground">{key.replace(/_/g, ' ')}:</dt>
                            <dd className="min-w-0 break-words">{String(value)}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : null}

                    {task.state === 'awaiting_approval' ? (
                      <div className="mb-4 space-y-2 rounded-md border border-input p-3">
                        <p className="text-sm font-medium">Your approval is required</p>
                        <Input type="password" autoComplete="current-password" placeholder="Confirm your password" value={approvalPassword} onChange={(event) => setApprovalPassword(event.target.value)} />
                        <Button disabled={busy || !approvalPassword} onClick={() => void approveTask(task.id)}>Approve and continue</Button>
                      </div>
                    ) : null}

                    <p className="mb-2 text-sm font-medium">Activity</p>
                    {!activity ? <p className="text-sm text-muted-foreground">Loading activity…</p> : timeline(activity).length === 0 ? (
                      <p className="text-sm text-muted-foreground">No activity has been recorded yet.</p>
                    ) : (
                      <ol className="space-y-3 border-l border-border pl-4">
                        {timeline(activity).map((row) => (
                          <li key={row.id} className="relative text-sm before:absolute before:-left-[1.18rem] before:top-1.5 before:h-2 before:w-2 before:rounded-full before:bg-primary">
                            <p>{row.label}</p>
                            {row.detail ? <p className="mt-0.5 break-words text-muted-foreground">{row.detail}</p> : null}
                            <p className="mt-0.5 text-xs text-muted-foreground">{when(row.at)}</p>
                          </li>
                        ))}
                      </ol>
                    )}
                  </div>
                ) : null}
                <p className="mt-3 text-xs text-muted-foreground">Started {when(task.created_at)} · Updated {elapsed(task.updated_at)} ago</p>
              </Card>
            );
          })}

          {visibleReminders.map((reminder) => (
            <Card key={`reminder-${reminder.id}`}>
              <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-words font-medium">{reminder.body}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {reminder.status === 'scheduled' ? `Due ${when(reminder.due_at)}` : `${plain('reminder_status', reminder.status)} ${when(reminder.delivered_at ?? reminder.due_at)}`}
                  </p>
                </div>
                <Badge tone={reminder.status === 'failed' ? 'danger' : reminder.status === 'delivered' ? 'ok' : 'muted'}>Reminder</Badge>
              </div>
              {reminder.status === 'scheduled' ? (
                <div className="mt-3"><Button type="button" variant="ghost" disabled={busy} onClick={() => void cancelReminder(reminder.id)}>Cancel</Button></div>
              ) : null}
            </Card>
          ))}
        </div>
      )}

      <details className="rounded-lg border border-border bg-card p-4">
        <summary className="min-h-11 cursor-pointer py-2 text-sm font-medium">Create a task manually</summary>
        <form onSubmit={create} className="mt-3 space-y-3 border-t border-border pt-4">
          <CardTitle>New background task</CardTitle>
          <select value={templateKey} onChange={(event) => setTemplateKey(event.target.value)} className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm">
            {types.map((type) => <option key={type.key} value={type.key}>{type.name}</option>)}
          </select>
          {selected?.requiresCapability ? <p className="text-sm text-muted-foreground">This will wait until {selected.requiresCapability.replace(/_/g, ' ')} is connected.</p> : null}
          {selected?.contract.slots.required.map((slot) => (
            <div key={slot}>
              <label className="mb-1 block text-sm" htmlFor={`slot-${slot}`}>{slot.replace(/_/g, ' ')}</label>
              <Input id={`slot-${slot}`} name={slot} required />
            </div>
          ))}
          <Button type="submit" disabled={busy || !selected}>{busy ? 'Creating…' : 'Create task'}</Button>
        </form>
      </details>
    </div>
  );
}
