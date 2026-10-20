import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { useWorkGoals, type WorkGoalSnapshot } from '@/lib/workGoals';

const labels: Record<string, string> = { accepted: 'Accepted', planning: 'Planning', working: 'In progress',
  waiting: 'Waiting', needs_instruction: 'Needs your input', paused: 'Paused', verifying: 'Checking the result',
  completed: 'Completed', cancelled: 'Cancelled' };
const stepLabels = { pending: 'Pending', working: 'In progress', blocked: 'Waiting', verified: 'Verified' };

export function WorkProgressCard({ goal, compact = false, refresh }: {
  goal: WorkGoalSnapshot; compact?: boolean; refresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [instruction, setInstruction] = useState('');
  const [editing, setEditing] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const ended = goal.state === 'completed' || goal.state === 'cancelled';
  const steps = compact && !showAll ? goal.steps.slice(0, 5) : goal.steps;
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
    <ol className="mt-3 space-y-2">
      {steps.map(step => <li key={step.id} className="flex items-start gap-2">
        <span aria-hidden className={step.state === 'verified' ? 'text-primary' : 'text-muted-foreground'}>{step.state === 'verified' ? '✓' : step.state === 'working' ? '◉' : '○'}</span>
        <span className="min-w-0 break-words">{step.title}<span className="ml-2 text-xs text-muted-foreground">{stepLabels[step.state]}</span></span>
      </li>)}
    </ol>
    {compact && goal.steps.length > 5 ? <button className="mt-2 min-h-10 text-xs underline" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show less' : `Show all ${goal.totalSteps} steps`}</button> : null}
    <p className="mt-3 text-sm text-muted-foreground">{goal.activity}</p>
    {goal.continuation?.kind === 'question' ? <p className="mt-2 rounded-lg bg-secondary p-3 text-sm">{goal.continuation.text}</p> : null}
    {goal.continuation?.kind === 'wait' ? <p className="mt-2 text-sm text-muted-foreground">{goal.continuation.reason}<br />Check requested for {new Date(goal.continuation.wakeAt).toLocaleString()}.</p> : null}
    <p className="mt-2 text-xs text-muted-foreground">{stale ? 'No recent update · ' : ''}Last saved {new Date(goal.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</p>
    {!compact ? <details className="mt-3 text-sm"><summary className="cursor-pointer text-muted-foreground">Outcome and saved work</summary>
      <p className="mt-3 font-medium">Finished means</p><ul className="mt-1 list-disc space-y-1 pl-5">{goal.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul>
      {(['decisions', 'facts', 'assumptions'] as const).map(kind => goal.checkpoint[kind]?.length ? <div key={kind} className="mt-3"><p className="font-medium capitalize">{kind}</p><ul className="mt-1 list-disc space-y-1 pl-5">{goal.checkpoint[kind].map((value, index) => <li key={index}>{value}</li>)}</ul></div> : null)}
      {goal.checkpoint.nextAction ? <p className="mt-3"><strong>Next: </strong>{goal.checkpoint.nextAction}</p> : null}
      <WorkMemoryEditor goal={goal} refresh={refresh} />
    </details> : null}
    <div className="mt-3 flex flex-wrap gap-2 text-xs">
      {compact ? <Link to={`/app/tasks#goal-${goal.goalId}`} className="inline-flex min-h-10 items-center rounded-md border border-border px-3">Open task manager ↗</Link> : null}
      {!ended && goal.state !== 'paused' ? <button disabled={busy} onClick={() => void control('pause')} className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50">Pause goal</button> : null}
      {!ended ? <button disabled={busy} onClick={() => setEditing(!editing)} className="min-h-10 rounded-md border border-border px-3">{goal.state === 'paused' ? 'Resume with instructions' : 'Add instructions'}</button> : null}
      {goal.state === 'verifying' ? <button disabled={busy} onClick={() => void control('confirm')} className="min-h-10 rounded-md bg-primary px-3 text-primary-foreground">Confirm outcome</button> : null}
      {!ended && !compact ? <button disabled={busy} onClick={() => void control('cancel')} className="min-h-10 rounded-md border border-border px-3">Cancel goal</button> : null}
    </div>
    {editing ? <form className="mt-3 space-y-2" onSubmit={event => { event.preventDefault(); void control('resume'); }}>
      <label className="block text-sm" htmlFor={`instruction-${goal.goalId}`}>What should Josi do next?</label>
      <textarea id={`instruction-${goal.goalId}`} value={instruction} onChange={event => setInstruction(event.target.value)} required maxLength={2000} rows={3} className="w-full rounded-lg border border-border bg-background p-3 text-base" />
      <p className="text-xs text-muted-foreground">Save this direction, then continue the work in chat. Actions already sent to a provider may still finish.</p>
      <button disabled={busy || !instruction.trim()} className="min-h-10 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">Save instructions</button>
    </form> : null}
    {error ? <p className="mt-2 text-sm text-destructive" role="alert">{error}</p> : null}
  </article>;
}

function WorkMemoryEditor({ goal, refresh }: { goal: WorkGoalSnapshot; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState({ decisions: '', facts: '', assumptions: '', nextAction: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  function edit() {
    setNotes({ decisions: (goal.checkpoint.decisions ?? []).join('\n'), facts: (goal.checkpoint.facts ?? []).join('\n'),
      assumptions: (goal.checkpoint.assumptions ?? []).join('\n'), nextAction: goal.checkpoint.nextAction ?? '' });
    setEditing(true); setSaved('');
  }
  async function change(action: 'correct' | 'pin' | 'unpin' | 'forget') {
    if (busy) return;
    if (action === 'forget' && !window.confirm('Clear these saved work notes? The task, evidence and original conversation remain.')) return;
    setBusy(true); setError(''); setSaved('');
    try {
      const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);
      await api.post(`/assistant/work-goals/${goal.goalId}/memory`, { revision: goal.revision, action,
        ...(action === 'correct' ? { checkpoint: { decisions: lines(notes.decisions), facts: lines(notes.facts), assumptions: lines(notes.assumptions), nextAction: notes.nextAction } } : {}) });
      setEditing(false); setSaved(action === 'forget' ? 'Saved notes cleared.' : 'Saved. Future work will use this version.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Saved work could not be changed.'); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 border-t border-border pt-3">
    <p className="text-xs text-muted-foreground">Saved work notes are context. They cannot change permissions or Cardinal Rules.</p>
    <div className="mt-2 flex flex-wrap gap-2 text-xs">
      <button disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={edit}>Correct notes</button>
      <button disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={() => void change(goal.checkpointPinned ? 'unpin' : 'pin')}>{goal.checkpointPinned ? 'Unpin from memory' : 'Pin for future work'}</button>
      <button disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={() => void change('forget')}>Clear saved notes</button>
    </div>
    {editing ? <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); void change('correct'); }}>
      {(['decisions', 'facts', 'assumptions', 'nextAction'] as const).map(key => <label key={key} className="block text-sm">{key === 'nextAction' ? 'Next action' : key === 'facts' ? 'Reported facts' : key === 'decisions' ? 'Decisions' : 'Assumptions'}
        <textarea rows={key === 'nextAction' ? 2 : 3} maxLength={key === 'nextAction' ? 2000 : 24000} required={key === 'nextAction'} value={notes[key]} onChange={event => setNotes(current => ({ ...current, [key]: event.target.value }))} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-base" />
      </label>)}
      <p className="text-xs text-muted-foreground">One item per line, up to 12 in each list. Put secrets in the Vault.</p>
      <button disabled={busy} className="min-h-10 rounded-md bg-primary px-4 text-primary-foreground">Save correction</button>
    </form> : null}
    {error ? <p role="alert" className="mt-2 text-sm text-destructive">{error}</p> : null}
    {saved ? <p role="status" className="mt-2 text-xs text-muted-foreground">{saved}</p> : null}
  </div>;
}

export function ChatWorkProgress({ threadId }: { threadId: string }) {
  const { goals, error, refresh } = useWorkGoals(threadId, true);
  if (!goals.length) return null;
  return <div className="space-y-3" aria-label="Current work progress">
    {error ? <p className="text-xs text-muted-foreground">Progress is offline. Showing the last saved update.</p> : null}
    {goals.slice(0, 6).map(goal => <WorkProgressCard key={goal.goalId} goal={goal} compact refresh={refresh} />)}
    {goals.length > 6 ? <Link className="inline-flex min-h-10 items-center text-sm underline" to="/app/tasks">See all saved work</Link> : null}
  </div>;
}

export function WorkGoalManager() {
  const { goals, error, refresh } = useWorkGoals(undefined, true);
  const [history, setHistory] = useState(false);
  const visible = goals.filter(goal => history === ['completed', 'cancelled'].includes(goal.state));
  if (!goals.length && !error) return null;
  return <section className="space-y-3" aria-label="Owned work">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">Owned work</h2>
      <button onClick={() => setHistory(!history)} className="min-h-10 text-sm underline">{history ? 'Show unfinished' : 'Show completed and cancelled'}</button></div>
    {error ? <p className="text-sm text-muted-foreground">Progress could not refresh. Saved results may be out of date.</p> : null}
    {visible.map(goal => <WorkProgressCard key={goal.goalId} goal={goal} refresh={refresh} />)}
    {!visible.length ? <p className="text-sm text-muted-foreground">No {history ? 'completed or cancelled' : 'unfinished'} goals.</p> : null}
  </section>;
}
