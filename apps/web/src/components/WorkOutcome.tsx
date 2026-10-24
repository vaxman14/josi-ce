import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { WorkGoalSnapshot } from '@/lib/workGoals';

interface OutcomeRecord {
  outcome_revision: number; goal_revision: number; outcome: string; criteria: string[];
  reason: string; source: string; created_at: string;
}
export function WorkOutcome({ goal, refresh }: { goal: WorkGoalSnapshot; refresh: () => Promise<void> }) {
  const [editing, setEditing] = useState(false), [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(goal.revision), [error, setError] = useState(''), [saved, setSaved] = useState('');
  const [outcome, setOutcome] = useState(''), [criteria, setCriteria] = useState(''), [reason, setReason] = useState('');
  const [continueWork, setContinueWork] = useState(true);
  const ended = ['completed', 'cancelled'].includes(goal.state);
  function edit() {
    setRevision(goal.revision); setOutcome(goal.title); setCriteria(goal.criteria.join('\n'));
    setReason(''); setContinueWork(goal.state !== 'paused'); setError(''); setSaved(''); setEditing(true);
  }
  async function save() {
    if (busy || ended || revision !== goal.revision) return;
    setBusy(true); setError(''); setSaved('');
    try {
      await api.post(`/assistant/work-goals/${goal.goalId}/outcome`, { revision, outcome,
        criteria: criteria.split('\n').map(value => value.trim()).filter(Boolean), reason, continueWork });
      setEditing(false); setSaved(continueWork ? 'Outcome saved. Josi must update its plan before continuing.' : 'Outcome saved. Work remains paused.');
      await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The outcome could not be updated.'); }
    finally { setBusy(false); }
  }
  return <div className="mt-3 space-y-3">
    {!ended ? <button type="button" disabled={busy} onClick={edit} className="min-h-10 rounded-md border border-border px-3 text-xs">Change requested outcome</button> : null}
    {editing && !ended ? <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-3 rounded-xl border border-border p-3">
      <p className="text-xs text-muted-foreground">Completed work and original steps stay saved. Josi must review the updated plan before new actions. Actions already sent may still finish. This change adds no permissions.</p>
      {revision !== goal.revision ? <div className="space-y-2">
        <p className="text-sm text-muted-foreground">Work changed while you were editing. Review the current result above; your edit is still here.</p>
        <button type="button" disabled={busy} onClick={() => setRevision(goal.revision)} className="min-h-10 rounded-md border border-border px-3 text-xs">I reviewed the change — keep my edit</button>
      </div> : null}
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-sm">Requested outcome
          <textarea value={outcome} onChange={event => setOutcome(event.target.value)} required maxLength={500} rows={2} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-base" />
        </label>
        <label className="block text-sm">Finished means
          <textarea value={criteria} onChange={event => setCriteria(event.target.value)} required maxLength={24000} rows={4} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-base" />
          <span className="mt-1 block text-xs text-muted-foreground">One criterion per line, up to 12. Retire individual obsolete steps using the task manager’s separate control. Cancel the goal if the entire request is no longer needed.</span>
        </label>
        <label className="block text-sm">What changed, and what should Josi do next?
          <textarea value={reason} onChange={event => setReason(event.target.value)} required maxLength={2000} rows={3} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-base" />
        </label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={continueWork} onChange={event => setContinueWork(event.target.checked)} />
          Let Josi update its plan and continue within existing permissions
        </label>
        <div className="flex flex-wrap gap-2">
          <button disabled={busy || revision !== goal.revision || !outcome.trim() || !criteria.trim() || !reason.trim()} className="min-h-10 rounded-md bg-primary px-4 text-sm text-primary-foreground disabled:opacity-50">{continueWork ? 'Save and continue' : 'Save paused'}</button>
          <button type="button" onClick={() => setEditing(false)} className="min-h-10 rounded-md border border-border px-3 text-sm">Cancel edit</button>
        </div>
      </fieldset>
    </form> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    {saved ? <p role="status" className="text-xs text-muted-foreground">{saved}</p> : null}
    {goal.outcomeRevision ? <OutcomeHistory goal={goal} /> : null}
  </div>;
}

function OutcomeHistory({ goal }: { goal: WorkGoalSnapshot }) {
  const [open, setOpen] = useState(false), [records, setRecords] = useState<OutcomeRecord[]>([]);
  const [before, setBefore] = useState<number | undefined>();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    let alive = true; setBusy(true); setError('');
    void api.get<{ outcomes: OutcomeRecord[] }>(`/assistant/work-goals/${goal.goalId}/outcomes${before ? `?before=${before}` : ''}`)
      .then(value => { if (alive) setRecords(value.outcomes); })
      .catch(cause => { if (alive) { setRecords([]); setError(cause instanceof Error ? cause.message : 'Outcome history is unavailable.'); } })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [open, goal.goalId, goal.outcomeRevision, before]);
  return <details onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer text-sm text-muted-foreground">Outcome history · Version {goal.outcomeRevision}</summary>
    {open ? <div className="mt-3 space-y-3" aria-busy={busy}>
      {records.map(record => <details key={record.outcome_revision} className="rounded-xl border border-border p-3">
        <summary className="cursor-pointer text-sm">Version {record.outcome_revision} · {record.outcome}</summary>
        <p className="mt-2 text-xs text-muted-foreground">{record.source === 'owner_edit' ? 'Changed by you' : record.source === 'existing_record' ? 'Retained from existing work' : 'Recorded from the original request'} · {new Date(record.created_at).toLocaleString()}</p>
        <p className="mt-2 text-sm">{record.reason}</p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{record.criteria.map((value, index) => <li key={index} className="break-words">{value}</li>)}</ul>
      </details>)}
      {busy ? <p className="text-xs text-muted-foreground">Loading outcome history…</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2 text-xs">
        <button type="button" disabled={busy || records.length < 20 || records.at(-1)?.outcome_revision === 1}
          onClick={() => setBefore(records.at(-1)?.outcome_revision)} className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50">Older outcomes</button>
        {before ? <button type="button" onClick={() => setBefore(undefined)} className="min-h-10 rounded-md border border-border px-3">Latest outcome</button> : null}
      </div>
    </div> : null}
  </details>;
}
