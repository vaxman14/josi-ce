import { useState } from 'react';
import type { WorkGoalSnapshot } from '@/lib/workGoals';
import { api } from '@/lib/api';

export function RetireWorkStep({ goal, refresh }: { goal: WorkGoalSnapshot; refresh(): Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [stepId, setStepId] = useState(''), [reason, setReason] = useState(''), [revision, setRevision] = useState(goal.revision);
  const [continueWork, setContinueWork] = useState(false);
  const remaining = goal.steps.filter(step => !['verified', 'skipped'].includes(step.state));
  const ended = ['completed', 'cancelled'].includes(goal.state);
  if (ended || !remaining.length || goal.retiredSteps === undefined) return null; // Older servers keep their existing controls.
  function edit() {
    setOpen(!open); setRevision(goal.revision); setStepId(''); setReason(''); setError('');
    setContinueWork(goal.state !== 'paused');
  }
  async function save() {
    if (busy || !stepId || revision !== goal.revision) return;
    setBusy(true); setError('');
    try {
      await api.post(`/assistant/work-goals/${goal.goalId}/retire-step`, { revision, stepId, reason, continueWork });
      setOpen(false); setStepId(''); setReason(''); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'This step could not be retired.'); }
    finally { setBusy(false); }
  }
  return <div className="mt-3 text-sm">
    <button disabled={busy || goal.totalSteps <= 1} className="min-h-10 rounded-md border border-border px-3 disabled:opacity-50" onClick={edit}>Retire obsolete step</button>
    {open ? <form className="mt-3 space-y-3 rounded-lg border border-border p-3" onSubmit={event => { event.preventDefault(); void save(); }}>
      <p className="text-xs text-muted-foreground">Only you can retire a step. Its history stays saved, but it stops counting as required work. Josi must review the remaining plan. An unresolved action or a task that is still open must be resolved first.</p>
      {revision !== goal.revision ? <div className="space-y-2 text-xs text-muted-foreground">
        <p>The work changed. Review the current steps above; your selection and reason remain here.</p>
        <button type="button" disabled={busy} className="min-h-10 rounded-md border border-border px-3" onClick={() => setRevision(goal.revision)}>I reviewed the current plan</button>
      </div> : null}
      <fieldset disabled={busy} className="space-y-3">
        <label className="block">Step no longer required
          <select required value={stepId} onChange={event => setStepId(event.target.value)} className="mt-1 min-h-11 w-full rounded-md border border-border bg-background p-2 text-base">
            <option value="">Choose a step</option>{remaining.map(step => <option key={step.id} value={step.id}>{step.title}</option>)}
          </select>
        </label>
        <label className="block">Why is this step obsolete?
          <textarea required rows={3} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} className="mt-1 w-full rounded-md border border-border bg-background p-2 text-base" />
        </label>
        <label className="flex items-start gap-2"><input type="checkbox" checked={continueWork} onChange={event => setContinueWork(event.target.checked)} />
          Let Josi review the plan and continue within its existing permissions</label>
        <button disabled={busy || !stepId || !reason.trim() || revision !== goal.revision} className="min-h-10 rounded-md bg-primary px-4 text-primary-foreground disabled:opacity-50">{busy ? 'Saving…' : 'Retire step and retain history'}</button>
      </fieldset>
    </form> : null}
    {error ? <p role="alert" className="mt-2 text-destructive">{error}</p> : null}
  </div>;
}
