import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useWorkGoals, type WorkGoalSnapshot } from '@/lib/workGoals';
import { WorkOutcome } from './WorkOutcome';
import { RetireWorkStep } from './RetireWorkStep';

const labels: Record<string, string> = { accepted: 'Accepted', planning: 'Planning', working: 'In progress',
  waiting: 'Waiting', needs_instruction: 'Needs your input', paused: 'Paused', verifying: 'Checking the result',
  completed: 'Completed', cancelled: 'Cancelled' };
const stepLabels = { pending: 'Pending', working: 'In progress', blocked: 'Waiting', verified: 'Verified', skipped: 'Retired by you' };

export function WorkProgressCard({ goal, compact = false, refresh }: {
  goal: WorkGoalSnapshot; compact?: boolean; refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ended = goal.state === 'completed' || goal.state === 'cancelled';
  const steps = compact && !showAll ? goal.steps.filter(step => step.state !== 'skipped').slice(0, 5) : goal.steps;
  const stale = !ended && Date.now() - Date.parse(goal.updatedAt) > 120_000;
  async function control(action: 'pause' | 'resume' | 'cancel' | 'confirm') {
    if (busy) return;
    if (action === 'cancel' && !window.confirm('Cancel this goal? Actions already sent to a provider may still finish.')) return;
    setBusy(true); setError('');
    try {
      await api.post(`/assistant/work-goals/${goal.goalId}/control`, { action, revision: goal.revision,
        ...(action === 'resume' ? { instruction } : {}) });
      setEditing(false); setInstruction(''); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The work could not be updated.'); }
    finally { setBusy(false); }
  }
  return <article id={`goal-${goal.goalId}`} className={`min-w-0 rounded-xl border border-border bg-card p-4 ${compact ? 'max-w-xl text-sm' : ''}`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <strong className="tabular-nums">{goal.verifiedSteps}/{goal.totalSteps} steps verified</strong>
      <span className={`rounded-full px-2.5 py-1 text-xs ${goal.state === 'completed' ? 'bg-primary/15 text-primary' : 'bg-secondary text-muted-foreground'}`}>{labels[goal.state]}</span>
    </div>
    <h3 className="mt-2 break-words font-semibold">{goal.title}</h3>
    {goal.retiredSteps ? <p className="mt-1 text-xs text-muted-foreground">{goal.retiredSteps} retired {goal.retiredSteps === 1 ? 'step' : 'steps'} retained in history; excluded from required work.</p> : null}
    <ol className="mt-3 space-y-2">
      {steps.map(step => <li key={step.id} className="flex items-start gap-2">
        <span aria-hidden className={step.state === 'verified' ? 'text-primary' : 'text-muted-foreground'}>{step.state === 'verified' ? '✓' : step.state === 'skipped' ? '—' : step.state === 'working' ? '◉' : '○'}</span>
        <span className="min-w-0 break-words">{step.title}<span className="ml-2 text-xs text-muted-foreground">{stepLabels[step.state]}</span>
          {step.state === 'blocked' && step.blockedReason ? <span className="mt-1 block text-xs text-muted-foreground">{step.blockedReason}
            {step.blockedUntil ? ` Check again ${new Date(step.blockedUntil).toLocaleString()}.` : ''}
          </span> : null}
          {step.retirement ? <span className="mt-1 block text-xs text-muted-foreground">Retired {new Date(step.retirement.at).toLocaleString()}: {step.retirement.reason}</span> : null}
          {!compact && step.dependsOn?.length ? <span className="mt-1 block text-xs text-muted-foreground">
            After: {step.dependsOn.map(id => goal.steps.find(value => value.id === id)?.title ?? 'Unavailable dependency').join(' · ')}
          </span> : null}
        </span>
      </li>)}
    </ol>
    {compact && (goal.steps.length > steps.length || showAll) ? <button className="mt-2 min-h-10 text-xs underline" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : `Show all ${goal.steps.length} saved steps`}</button> : null}
    <p className="mt-3 text-sm text-muted-foreground">{goal.activity}</p>
    {goal.planNeedsReview && !ended ? <p className="mt-2 text-sm text-muted-foreground">Your outcome or required work changed. New actions wait for a plan reviewed against the current criteria.</p> : null}
    {!compact && goal.automaticWork && !ended ? <p className="mt-1 text-xs text-muted-foreground">
      {goal.automaticWork.segmentsSinceVerifiedProgress}/{goal.automaticWork.segmentLimit} automatic work segments since the last verified step.
      {goal.automaticWork.nextCheckAt && ['planning', 'working'].includes(goal.state) ? ' Next continuation is scheduled.' : ''}
    </p> : null}
    {goal.continuation?.kind === 'question' ? <p className="mt-2 rounded-lg bg-secondary p-3 text-sm">{goal.continuation.text}</p> : null}
    {goal.continuation?.kind === 'wait' ? <p className="mt-2 text-sm text-muted-foreground">{goal.continuation.reason}<br />Check requested for {new Date(goal.continuation.wakeAt).toLocaleString()}.</p> : null}
    <p className="mt-2 text-xs text-muted-foreground">{stale ? 'No recent update · ' : ''}Last saved {new Date(goal.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
    {!compact ? <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted-foreground">Outcome and saved work</summary>
      <p className="mt-3 font-medium">Finished means</p><ul className="mt-1 list-disc space-y-1 pl-5">{goal.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
      {goal.outcomeRevision ? <WorkOutcome goal={goal} refresh={refresh} /> : null}
      {goal.ownerCheckpoint ? <div className="mt-3 rounded-lg border border-border p-3">
        <p className="font-medium">Your saved correction</p>
        <p className="mt-1 text-xs text-muted-foreground">Josi cannot replace this with its own notes. {goal.ownerCheckpointAt ? `Saved ${new Date(goal.ownerCheckpointAt).toLocaleString()}.` : ''}</p>
        <CheckpointNotes checkpoint={goal.ownerCheckpoint} />
      </div> : null}
      <p className="mt-3 font-medium">Latest progress notes</p>
      {goal.ownerCheckpoint ? <p className="mt-1 text-xs text-muted-foreground">New progress appears here separately. If it conflicts with your correction, Josi must ask you to resolve the difference.</p> : null}
      <CheckpointNotes checkpoint={goal.checkpoint} />
      <WorkMemoryEditor goal={goal} refresh={refresh} />
    </details> : null}
    {!compact ? <WorkActivity goal={goal} /> : null}
    {!compact ? <WorkPlans goal={goal} /> : null}
    {!compact ? <RetireWorkStep goal={goal} refresh={refresh} /> : null}
    {!compact ? <WorkChannelProgress goalId={goal.goalId} /> : null}
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {compact ? <Link to={`/app/tasks#goal-${goal.goalId}`} className="inline-flex min-h-10 items-center rounded-md border border-border px-3">Open task manager ↗</Link> : null}
      {!compact ? <Link to={`/app/talk?thread=${goal.threadId}`} className="inline-flex min-h-10 items-center rounded-md border border-border px-3">Continue in chat ↗</Link> : null}
      {!ended && goal.state !== 'paused' ? <button disabled={busy} onClick={() => void control('pause')} className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50">Pause goal</button> : null}
      {!ended ? <button disabled={busy} onClick={() => setEditing(!editing)} className="min-h-10 rounded-md border border-border px-3">{goal.state === 'paused' ? 'Resume with instructions' : 'Add instructions'}</button> : null}
      {goal.state === 'verifying' ? <button disabled={busy} onClick={() => void control('confirm')} className="min-h-10 rounded-md bg-primary px-3 text-primary-foreground">Confirm outcome</button> : null}
      {!ended && !compact ? <button disabled={busy} onClick={() => void control('cancel')} className="min-h-10 rounded-md border border-border px-3">Cancel goal</button> : null}
    </div>
    {editing ? <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); void control('resume'); }}>
      <label className="block text-sm" htmlFor={`instruction-${goal.goalId}`}>What should Josi do next?</label>
      <textarea id={`instruction-${goal.goalId}`} value={instruction} onChange={event => setInstruction(event.target.value)} required maxLength={2000} rows={3} className="w-full rounded-lg border border-border bg-background p-3 text-base" />
      <p className="text-xs text-muted-foreground">Save this direction and Josi will continue within its permissions. Missing access or an uncertain result comes back here for your instructions. Actions already sent to a provider may still finish.</p>
      <button disabled={busy || !instruction.trim()} className="min-h-10 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">Save and continue</button>
    </form> : null}
    {error ? <p className="mt-2 text-sm text-destructive" role="alert">{error}</p> : null}
  </article>;
}

function CheckpointNotes({ checkpoint }: { checkpoint: WorkGoalSnapshot['checkpoint'] }) {
  return <>{(['decisions', 'facts', 'assumptions'] as const).map(kind => checkpoint[kind]?.length ? <div key={kind} className="mt-3">
    <p className="font-medium">{kind === 'facts' ? 'Reported facts' : kind === 'decisions' ? 'Decisions' : 'Assumptions'}</p>
    <ul className="mt-1 list-disc space-y-1 pl-5">{checkpoint[kind].map((value, index) => <li key={index}>{value}</li>)}</ul>
  </div> : null)}{checkpoint.nextAction ? <p className="mt-3"><strong>Next action noted: </strong>{checkpoint.nextAction}</p> : null}</>;
}

function WorkMemoryEditor({ goal, refresh }: { goal: WorkGoalSnapshot; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [editingRevision, setEditingRevision] = useState(goal.revision);
  const [notes, setNotes] = useState({ decisions: '', facts: '', assumptions: '', nextAction: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  function edit(latest = false) {
    const checkpoint = latest ? goal.checkpoint : goal.ownerCheckpoint ?? goal.checkpoint;
    setNotes({ decisions: (checkpoint.decisions ?? []).join('\n'), facts: (checkpoint.facts ?? []).join('\n'),
      assumptions: (checkpoint.assumptions ?? []).join('\n'), nextAction: checkpoint.nextAction ?? '' });
    setEditingRevision(goal.revision);
    setEditing(true); setSaved('');
  }
  async function change(action: 'correct' | 'pin' | 'unpin' | 'forget') {
    if (busy) return;
    if (action === 'forget' && !window.confirm('Clear the latest progress notes and your saved correction? The task, evidence and original conversation remain. Later work may save new progress.')) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
      await api.post(`/assistant/work-goals/${goal.goalId}/memory`, { revision: action === 'correct' ? editingRevision : goal.revision, action,
        ...(action === 'correct' ? { checkpoint: { decisions: lines(notes.decisions), facts: lines(notes.facts), assumptions: lines(notes.assumptions), nextAction: notes.nextAction } } : {}) });
      setEditing(false); setSaved(action === 'forget' ? 'Saved notes and correction cleared.' : 'Saved. Future work will load the current version.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Saved work could not be changed.'); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 border-t border-border pt-3">
    <p className="text-xs text-muted-foreground">Saved work notes are context. They cannot change permissions or Cardinal Rules.</p>
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      <button disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={() => edit()}>{goal.ownerCheckpoint ? 'Edit your correction' : 'Correct notes'}</button>
      {goal.ownerCheckpoint ? <button disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={() => edit(true)}>Review latest notes as a correction</button> : null}
      <button disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={() => void change(goal.checkpointPinned ? 'unpin' : 'pin')}>{goal.checkpointPinned ? 'Unpin from memory' : 'Pin for future work'}</button>
      <button disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={() => void change('forget')}>Clear saved notes</button>
    </div>
    {editing ? <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void change('correct'); }}>
      {editingRevision !== goal.revision ? <div className="space-y-2 text-sm text-muted-foreground">
        <p>Work changed while you were editing. Your text stays here; review the latest notes above before saving a new correction.</p>
        <button type="button" disabled={busy} onClick={() => setEditingRevision(goal.revision)} className="min-h-10 rounded-md border border-border px-3">I reviewed the change — keep my edit</button>
      </div> : null}
      <fieldset disabled={busy} className="space-y-3">
      {(['decisions', 'facts', 'assumptions', 'nextAction'] as const).map(key => <label key={key} className="block text-sm">{key === 'nextAction' ? 'Next action' : key === 'facts' ? 'Reported facts' : key === 'decisions' ? 'Decisions' : 'Assumptions'}
        <textarea rows={key === 'nextAction' ? 2 : 3} maxLength={key === 'nextAction' ? 2000 : 24000} required={key === 'nextAction'} value={notes[key]} onChange={event => setNotes(current => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-base" />
      </label>)}
      <p className="text-xs text-muted-foreground">One item per line, up to 12 in each list. Put secrets in the Vault.</p>
      <button disabled={busy || editingRevision !== goal.revision} className="min-h-10 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50">Save correction</button>
      </fieldset>
    </form> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    {saved ? <p role="status" className="mt-2 text-xs text-muted-foreground">{saved}</p> : null}
  </div>;
}

interface ActivityEvent { id: string; sequence: number; kind: string; summary: string; created_at: string }
function WorkChannelProgress({ goalId }: { goalId: string }) {
  const [progress, setProgress] = useState<{ channel: string; state: string; revision: number; currentRevision: number } | null>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true, pending = false;
    async function load() {
      if (!alive || pending || document.hidden) return;
      pending = true;
      try {
        const value = await api.get<{ progress: typeof progress }>(`/assistant/work-goals/${goalId}/channel-progress`);
        if (alive) { setProgress(value.progress); setOffline(false); }
      } catch { if (alive) setOffline(true); }
      finally { pending = false; }
    }
    void load();
    const timer = window.setInterval(() => void load(), 15_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [goalId]);
  if (!progress) return null;
  const message = progress.state === 'uncertain' ? 'Delivery could not be confirmed. Josi will not send a duplicate automatically; follow current work here.'
    : progress.state === 'failed' ? 'The Telegram summary could not be updated. Follow current work here.'
    : progress.state === 'disabled' ? 'The original Telegram connection is no longer active.'
    : progress.state === 'sent' && progress.revision >= progress.currentRevision ? 'The Telegram summary is up to date.'
    : 'The Telegram summary is waiting for its next update.';
  return <p className="mt-3 text-xs text-muted-foreground">{offline ? 'Channel status could not refresh. ' : ''}{message}</p>;
}
interface SavedPlan { plan_revision: number; goal_revision: number; outcome_revision?: number; steps: WorkGoalSnapshot['steps']; reason: string; created_at: string }
function WorkPlans({ goal }: { goal: WorkGoalSnapshot }) {
  const [open, setOpen] = useState(false), [plans, setPlans] = useState<SavedPlan[]>([]);
  const [before, setBefore] = useState<number | undefined>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true; setBusy(true); setError('');
    void api.get<{ plans: SavedPlan[] }>(`/assistant/work-goals/${goal.goalId}/plans${before ? `?before=${before}` : ''}`)
      .then(value => { if (alive) setPlans(value.plans); })
      .catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Plan history is unavailable.'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open, goal.goalId, goal.planRevision, before]);
  return <details className="mt-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-muted-foreground">Plan history{goal.planRevision ? ` · Version ${goal.planRevision}` : ''}</summary>
    {open ? <div className="mt-3 space-y-3" aria-busy={busy}>
      <p className="text-xs text-muted-foreground">Changes retain original steps and receipts. Revising the plan does not change permissions or the required outcome.</p>
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {plans.map(plan => <details key={plan.plan_revision} className="rounded-lg border border-border p-3">
        <summary className="cursor-pointer">Version {plan.plan_revision} · {plan.reason}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{new Date(plan.created_at).toLocaleString()}{plan.outcome_revision ? ` · Outcome version ${plan.outcome_revision}` : ''}</p>
        <ol className="mt-2 list-decimal space-y-2 pl-5">{plan.steps.map(step => <li key={step.id} className="break-words">
          {step.state === 'skipped' ? <span className="mr-2 text-xs text-muted-foreground">Retired by owner</span> : null}
          {step.title}<span className="mt-1 block text-xs text-muted-foreground">{step.dependsOn?.length
            ? `After: ${step.dependsOn.map(id => plan.steps.find(value => value.id === id)?.title ?? 'Unavailable dependency').join(' · ')}`
            : 'Independent step'}</span>
          {step.retirement ? <span className="mt-1 block text-xs text-muted-foreground">Reason: {step.retirement.reason}</span> : null}
        </li>)}</ol>
      </details>)}
      {busy ? <p className="text-xs text-muted-foreground">Loading plans…</p> : null}
      <div className="flex flex-wrap gap-2 text-xs">
        <button disabled={busy || plans.length < 20 || plans.at(-1)?.plan_revision === 1}
          onClick={() => setBefore(plans.at(-1)?.plan_revision)}
          className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50">Older plans</button>
        {before ? <button onClick={() => setBefore(undefined)} className="min-h-10 rounded-md border border-border px-3">Latest plan</button> : null}
      </div>
    </div> : null}
  </details>;
}
function WorkActivity({ goal }: { goal: WorkGoalSnapshot }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [page, setPage] = useState<{ before?: number; after?: number }>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const latest = page.before === undefined && page.after === undefined;
  const revision = latest ? goal.revision : 0;
  useEffect(() => {
    if (!open) return;
    let alive = true; setBusy(true); setError('');
    const query = new URLSearchParams({ limit: '40' });
    if (page.before !== undefined) query.set('before', String(page.before));
    else query.set('after', String(page.after ?? Math.max(0, revision - 40)));
    void api.get<{ events: ActivityEvent[] }>(`/assistant/work-goals/${goal.goalId}/events?${query}`).then(result => {
      if (alive) setEvents(result.events);
    }).catch(cause => { if (alive) setError(cause instanceof Error ? cause.message : 'Activity is unavailable.'); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open, goal.goalId, revision, page.before, page.after]);
  return <details className="mt-3 text-sm" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-muted-foreground">Activity history</summary>
    {open ? <div className="mt-3 space-y-3">
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      <ol className="space-y-3 border-l border-border pl-4" aria-busy={busy}>
        {events.map(event => <li key={event.id}><p>{event.summary}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{new Date(event.created_at).toLocaleString()} · Update {event.sequence}</p></li>)}
      </ol>
      {busy ? <p className="text-xs text-muted-foreground">Loading activity…</p> : !events.length ? <p className="text-xs text-muted-foreground">No saved activity on this page.</p> : null}
      <div className="flex flex-wrap gap-2 text-xs">
        <button disabled={busy || !events.length || events[0].sequence <= 1} className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50"
          onClick={() => setPage({ before: events[0].sequence })}>Older updates</button>
        <button disabled={busy || !events.length || events[events.length - 1].sequence >= goal.revision} className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50"
          onClick={() => setPage({ after: events[events.length - 1].sequence })}>Newer updates</button>
        {!latest ? <button className="min-h-10 rounded-md border border-border px-3" onClick={() => setPage({})}>Follow latest</button> : null}
      </div>
    </div> : null}
  </details>;
}

export function ChatWorkProgress({ threadId }: { threadId: string }) {
  const { goals, error, refresh, connection } = useWorkGoals(threadId, true);
  if (!goals.length && !error) return null;
  return <div className="space-y-3" aria-label="Current work progress">
    {error ? <p className="text-xs text-muted-foreground">Progress is offline. Showing the last saved update.</p> : null}
    {!error && connection === 'live' ? <p className="text-xs text-muted-foreground">Live work updates</p> : null}
    {goals.slice(0, 6).map(goal => <WorkProgressCard key={goal.goalId} goal={goal} compact refresh={refresh} />)}
    {goals.length > 6 ? <Link className="inline-flex min-h-10 items-center text-sm underline" to="/app/tasks">See all saved work</Link> : null}
  </div>;
}

export function WorkGoalManager() {
  const [view, setView] = useState('unfinished');
  const [search, setSearch] = useState('');
  const { goals, error, refresh, connection } = useWorkGoals(undefined, false, view === 'history');
  const views = [{ id: 'unfinished', label: 'Unfinished' }, { id: 'working', label: 'Working' },
    { id: 'attention', label: 'Needs you' }, { id: 'waiting', label: 'Waiting / scheduled' },
    { id: 'paused', label: 'Paused' }, { id: 'history', label: 'History' }];
  const matches = (goal: WorkGoalSnapshot, group: string) => group === 'unfinished' || group === 'history'
    || (group === 'working' && ['accepted', 'planning', 'working'].includes(goal.state))
    || (group === 'attention' && ['needs_instruction', 'verifying'].includes(goal.state))
    || (group === 'waiting' && goal.state === 'waiting') || (group === 'paused' && goal.state === 'paused');
  const currentGoals = goals.filter(goal => (view === 'history') === ['completed', 'cancelled'].includes(goal.state));
  const visible = currentGoals.filter(goal => matches(goal, view) && (!search.trim()
    || `${goal.title} ${goal.activity} ${goal.steps.map(step => step.title).join(' ')}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())));
  return <section className="space-y-3" aria-label="Owned work">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Owned work</h2>
      <span className="text-xs text-muted-foreground">{connection === 'live' ? 'Live updates' : connection === 'offline' ? 'Offline' : connection === 'connecting' ? 'Connecting…' : 'Refreshing periodically'}</span></div>
    <div className="flex flex-wrap gap-2" aria-label="Work views">{views.map(item => <button key={item.id}
      aria-pressed={view === item.id} onClick={() => setView(item.id)}
      className={`min-h-10 rounded-lg border px-3 text-sm ${view === item.id ? 'border-primary bg-primary/10 text-primary' : 'border-border'}`}>
      {item.label}{item.id !== 'history' && view !== 'history' ? ` (${currentGoals.filter(goal => matches(goal, item.id)).length})` : ''}
    </button>)}</div>
    <label className="block text-sm">Find work
      <input type="search" value={search} onChange={event => setSearch(event.target.value)} maxLength={200}
        placeholder="Search goals, steps or activity" className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base" />
    </label>
    {view === 'history' ? <p className="text-xs text-muted-foreground">The most recent 100 completed or cancelled goals. Their activity remains saved.</p> : null}
    {error ? <p className="text-sm text-muted-foreground">Progress could not refresh. Saved results may be out of date.</p> : null}
    {visible.map(goal => <WorkProgressCard key={goal.goalId} goal={goal} refresh={refresh} />)}
    {!visible.length ? <p className="text-sm text-muted-foreground">{connection === 'connecting' ? 'Loading saved work…' : 'No goals match this view.'}</p> : null}
  </section>;
}
