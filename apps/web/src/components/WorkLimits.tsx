import { useState } from 'react';
import { api } from '@/lib/api';
import type { WorkGoalSnapshot } from '@/lib/workGoals';

function localDate(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}
export function WorkLimits({ goal, refresh }: { goal: WorkGoalSnapshot; refresh: () => Promise<void> }) {
  const saved = goal.automaticWork;
  const [editing, setEditing] = useState(false), [revision, setRevision] = useState(goal.revision);
  const [limited, setLimited] = useState(false), [runs, setRuns] = useState('12');
  const [timed, setTimed] = useState(false), [deadline, setDeadline] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (saved?.runsUsed === undefined || ['completed', 'cancelled'].includes(goal.state)) return null;
  function edit() {
    setRevision(goal.revision); setLimited(saved?.runLimit != null); setTimed(!!saved?.deadline);
    setRuns(String(saved?.runLimit ?? Math.min(10000, (saved?.runsUsed ?? 0) + 12)));
    setDeadline(localDate(saved?.deadline ?? new Date(Date.now() + 3_600_000).toISOString()));
    setError(''); setEditing(true);
  }
  async function save() {
    const count = Number(runs), date = timed ? new Date(deadline) : null;
    if (limited && (!/^\d+$/.test(runs) || !Number.isSafeInteger(count) || count < 0 || count > 10000)
      || timed && (!deadline || !Number.isFinite(date!.getTime()))) {
      setError('Use a total from 0 to 10,000 runs and a valid local deadline.'); return;
    }
    setBusy(true); setError('');
    try {
      await api.post(`/assistant/work-goals/${goal.goalId}/limits`, { revision,
        runLimit: limited ? count : null, deadline: date?.toISOString() ?? null });
      setEditing(false); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'The limits could not be saved.'); }
    finally { setBusy(false); }
  }
  const changed = revision !== goal.revision;
  return <section className="mt-3 rounded-xl border border-border p-3 text-sm">
    <h4 className="font-medium">Work limits</h4>
    <p className="mt-1">{saved.runsUsed} background runs used
      {saved.runLimit == null ? ' · No goal-specific run limit' : ` · Total allowed: ${saved.runLimit}`}.</p>
    <p className="mt-1">{saved.deadline ? `Deadline: ${new Date(saved.deadline).toLocaleString()}` : 'No goal-specific deadline.'}</p>
    <p className="mt-2 text-xs text-muted-foreground">Runs include queued and interrupted background work. Progress and Resume do not reset the count.
      These limits stop new background work; actions already sent may finish. Account limits and tool permissions still apply.</p>
    {!editing ? <button onClick={edit} className="mt-2 min-h-10 rounded-md border border-border px-3">Edit work limits</button>
      : <form className="mt-3 space-y-3" onSubmit={event => { event.preventDefault(); if (!changed && !busy) void save(); }}>
        {changed ? <div role="status"><p>Work changed. Review the latest saved work before applying your edit.</p>
          <button type="button" onClick={() => setRevision(goal.revision)} className="min-h-10 underline">I reviewed the change</button></div> : null}
        <label className="flex items-center gap-2"><input type="checkbox" checked={limited} onChange={e => setLimited(e.target.checked)} />Set a total background-run limit</label>
        {limited ? <label className="block">Total runs allowed
          <input type="number" min={0} max={10000} step={1} value={runs} onChange={e => setRuns(e.target.value)}
            className="ml-2 w-28 rounded border border-border bg-background p-2" /></label> : null}
        <label className="flex items-center gap-2"><input type="checkbox" checked={timed} onChange={e => setTimed(e.target.checked)} />Set a background-work deadline</label>
        {timed ? <label className="block">Deadline in your local time
          <input type="datetime-local" value={deadline} onChange={e => setDeadline(e.target.value)}
            className="mt-1 block rounded border border-border bg-background p-2" /></label> : null}
        <p className="text-xs text-muted-foreground">Saving keeps paused work paused. If a limit was reached, save a larger allowance, then resume with instructions.</p>
        <div className="flex gap-2">
          <button disabled={busy || changed} className="min-h-10 rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-50">Save limits</button>
          <button type="button" disabled={busy} onClick={() => setEditing(false)} className="min-h-10 rounded-md border border-border px-3">Cancel edit</button>
        </div>
      </form>}
    {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
  </section>;
}
