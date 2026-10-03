import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';

type DoctorState = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  key: string;
  label: string;
  state: DoctorState;
  detail: string;
}

interface DoctorDiagnosis {
  checkedAt: string;
  healthy: boolean;
  safeRepairAvailable: boolean;
  failed: string[];
  checks: DoctorCheck[];
  fingerprint: string;
}

interface DoctorStatus {
  available: boolean;
  diagnosis: DoctorDiagnosis | null;
  lastPlan: { status: string; created_at: string; applied_at: string | null } | null;
  message?: string;
}

interface DoctorPlan {
  id: string;
  expiresAt: string;
  planSha256: string;
  plan: { label: string; summary: string; notes: string[]; failedChecks: string[] };
  modelUsed: boolean;
  modelRole: 'primary' | 'fallback' | null;
  diagnosis: DoctorDiagnosis;
}

interface RepairResult {
  status: 'complete' | 'failed';
  diagnosis: DoctorDiagnosis;
}

const STATE_LABEL: Record<DoctorState, string> = {
  pass: 'Working', warn: 'Attention', fail: 'Needs repair',
};

function Diagnosis({ value }: { value: DoctorDiagnosis }) {
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>What Josi checked</CardTitle>
        <span className="text-xs text-muted-foreground">{new Date(value.checkedAt).toLocaleString()}</span>
      </div>
      <ul className="mt-2 divide-y divide-border">
        {value.checks.map((check) => (
          <li key={check.key} className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <span className="min-w-0">
              <span className="block text-sm font-medium">{check.label}</span>
              <span className="block text-sm text-muted-foreground">{check.detail}</span>
            </span>
            <span className="shrink-0">
              <Badge tone={check.state === 'pass' ? 'ok' : check.state === 'fail' ? 'danger' : 'muted'}>
                {STATE_LABEL[check.state]}
              </Badge>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Browser-first recovery for an owner who should not need to know Docker.
 * The model explains a redacted diagnosis. It never chooses or expands the
 * action; the only approvable action is the fixed reversible safe repair. */
export function AdminDiagnostics() {
  const [status, setStatus] = useState<DoctorStatus | null>(null);
  const [diagnosis, setDiagnosis] = useState<DoctorDiagnosis | null>(null);
  const [plan, setPlan] = useState<DoctorPlan | null>(null);
  const [busy, setBusy] = useState<'load' | 'check' | 'plan' | 'repair' | null>('load');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const next = await api.get<DoctorStatus>('/admin/doctor');
      setStatus(next); setDiagnosis(next.diagnosis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Josi Doctor could not load.');
    } finally { setBusy(null); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function runCheck() {
    setBusy('check'); setError(''); setNote(''); setPlan(null);
    try {
      const next = await api.post<DoctorDiagnosis>('/admin/doctor/check');
      setDiagnosis(next);
      setNote(next.healthy ? 'Everything Josi checked is working.' : 'The check found something that needs attention.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The system check did not finish.');
    } finally { setBusy(null); }
  }

  async function prepareRepair() {
    setBusy('plan'); setError(''); setNote(''); setPlan(null);
    try {
      const next = await api.post<DoctorPlan>('/admin/doctor/plan');
      setPlan(next); setDiagnosis(next.diagnosis);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Josi could not prepare a safe repair.');
    } finally { setBusy(null); }
  }

  async function applyRepair() {
    if (!plan) return;
    setBusy('repair'); setError(''); setNote('');
    try {
      const result = await api.post<RepairResult>('/admin/doctor/repair', { planId: plan.id, planSha256: plan.planSha256 });
      setDiagnosis(result.diagnosis); setPlan(null);
      setNote(result.diagnosis.healthy ? 'Repair complete. Josi reran the check and everything is working.' : 'The repair finished, but something still needs attention.');
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === 'object' && 'diagnosis' in err.body) {
        setDiagnosis((err.body as { diagnosis: DoctorDiagnosis }).diagnosis);
      }
      setPlan(null);
      setError(err instanceof Error ? err.message : 'The repair did not finish. Run a fresh check before trying again.');
    } finally { setBusy(null); }
  }

  const unavailable = status?.available === false;
  const running = busy !== null;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">System checkup</h1>
        <p className="mt-1 text-sm text-muted-foreground">Josi Doctor checks this installation, explains problems plainly, and can repair a limited set of safe problems after you approve the exact plan.</p>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {note ? <p role="status" className="rounded-lg border border-border bg-card p-3 text-sm">{note}</p> : null}

      {unavailable ? (
        <Card>
          <CardTitle>Josi Doctor needs one refresh</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">{status?.message}</p>
          <p className="mt-2 text-sm text-muted-foreground">Run the same Josi installer command once. It will add the isolated repair helper without replacing your data.</p>
        </Card>
      ) : (
        <Card>
          <CardTitle>{diagnosis?.healthy ? 'Josi looks healthy' : diagnosis ? 'Josi found a problem' : 'Check this installation'}</CardTitle>
          <p className="mt-2 text-sm text-muted-foreground">This checks Josi, Docker, storage, the database, networking, backups, notifications, and background work.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" disabled={running} onClick={() => void runCheck()}>{busy === 'check' || busy === 'load' ? 'Checking…' : 'Check system'}</Button>
            {diagnosis && !diagnosis.healthy && diagnosis.safeRepairAvailable ? (
              <Button type="button" variant="secondary" disabled={running} onClick={() => void prepareRepair()}>{busy === 'plan' ? 'Preparing…' : 'Prepare automatic fix'}</Button>
            ) : null}
          </div>
          {diagnosis && !diagnosis.healthy && !diagnosis.safeRepairAvailable ? <p className="mt-3 text-sm text-muted-foreground">This problem is outside Doctor's safe repair boundary. It will not guess or change unrelated software.</p> : null}
        </Card>
      )}

      {plan ? (
        <Card className="border-primary/50">
          <CardTitle>Review the repair</CardTitle>
          <p className="mt-2 text-sm">{plan.plan.summary}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted-foreground">{plan.plan.notes.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
          <p className="mt-3 text-xs text-muted-foreground">{plan.modelUsed ? `Josi's configured ${plan.modelRole ?? ''} model explained this redacted diagnosis. The model cannot choose commands or expand the repair.` : 'The configured model was unavailable, so Josi used its built-in explanation. The repair boundary is unchanged.'}</p>
          <p className="mt-2 text-xs text-muted-foreground">Doctor takes a snapshot first, verifies the result, and rolls back if readiness gets worse.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button type="button" disabled={running} onClick={() => void applyRepair()}>{busy === 'repair' ? 'Repairing and verifying…' : 'Apply approved fix'}</Button>
            <Button type="button" variant="ghost" disabled={running} onClick={() => setPlan(null)}>Cancel</Button>
          </div>
        </Card>
      ) : null}
      {diagnosis ? <Diagnosis value={diagnosis} /> : null}
      <p className="text-xs text-muted-foreground">If the Josi website itself will not open, rerun the installer command. A browser page cannot repair a server it cannot reach.</p>
    </div>
  );
}
