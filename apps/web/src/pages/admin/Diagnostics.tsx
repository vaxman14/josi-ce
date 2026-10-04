import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';
import { doctorCheckDestination, orderDoctorChecks } from '@/lib/doctorChecks';

type DoctorState = 'pass' | 'warn' | 'fail';

interface DoctorCheck {
  key: string;
  label: string;
  state: DoctorState;
  detail: string;
}

export interface DoctorDiagnosis {
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

interface UpdateJob {
  state: 'idle' | 'running' | 'complete' | 'rolled_back' | 'failed';
  currentVersion: string;
  targetVersion: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  message: string;
}
interface StableRelease { version: string; name: string; notes: string; url: string; publishedAt: string }
interface UpdateStatus {
  currentVersion: string;
  availableVersion: string | null;
  updateAvailable: boolean;
  lastCheckAt?: string | null;
  lastCheckOk?: boolean | null;
  automatic: false;
  job: UpdateJob;
  release?: StableRelease;
}

const STATE_LABEL: Record<DoctorState, string> = {
  pass: 'Working', warn: 'Attention', fail: 'Needs repair',
};

export function Diagnosis({ value }: { value: DoctorDiagnosis }) {
  const checks = orderDoctorChecks(value.checks);
  const failures = checks.filter((check) => check.state === 'fail');
  const remaining = checks.filter((check) => check.state !== 'fail');
  return (
    <div id="doctor-checks">
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>What Josi checked</CardTitle>
        <span className="text-xs text-muted-foreground">{new Date(value.checkedAt).toLocaleString()}</span>
      </div>
      {failures.length ? (
        <ul className="mt-3 space-y-2" aria-label="Checks needing repair">
          {failures.map((check) => {
            const destination = doctorCheckDestination(check.key);
            return (
              <li key={check.key}>
                <Link to={destination.to} className="group flex min-h-11 flex-col gap-2 rounded-md border border-destructive/60 bg-destructive/10 p-3 hover:bg-destructive/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{check.label}</span>
                    <span className="mt-1 block text-sm text-muted-foreground">{check.detail}</span>
                    <span className="mt-2 block text-xs font-medium text-destructive group-hover:underline">{destination.action} →</span>
                  </span>
                  <span className="shrink-0">
                    <Badge tone="danger">{STATE_LABEL.fail}</Badge>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {remaining.length ? (
        <details className="mt-3 rounded-md border border-border">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-2 text-sm font-medium hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>{failures.length ? `${remaining.length} other checks` : `All ${remaining.length} checks`}</span>
            <span className="text-xs text-muted-foreground">Click to expand</span>
          </summary>
          <ul className="divide-y divide-border border-t border-border">
            {remaining.map((check) => (
              <li key={check.key}>
                <details>
                  <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 px-3 py-3 hover:bg-secondary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                    <span className="min-w-0 text-sm font-medium">{check.label}</span>
                    <span className="shrink-0">
                      <Badge tone={check.state === 'pass' ? 'ok' : 'muted'}>
                        {STATE_LABEL[check.state]}
                      </Badge>
                    </span>
                  </summary>
                  <div className="border-t border-border/70 px-3 py-3 text-sm text-muted-foreground">{check.detail}</div>
                </details>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Card>
    </div>
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
  const [update, setUpdate] = useState<UpdateStatus | null>(null);
  const [updateBusy, setUpdateBusy] = useState<'load' | 'check' | 'start' | null>('load');
  const [updateError, setUpdateError] = useState('');
  const [confirmation, setConfirmation] = useState('');

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

  const loadUpdate = useCallback(async () => {
    try { setUpdate(await api.get<UpdateStatus>('/admin/doctor/update')); setUpdateError(''); }
    catch (err) { setUpdateError(err instanceof Error ? err.message : 'The updater could not load.'); }
    finally { setUpdateBusy(null); }
  }, []);

  useEffect(() => { void loadUpdate(); }, [loadUpdate]);
  useEffect(() => {
    if (update?.job.state !== 'running') return;
    const timer = window.setInterval(() => { void loadUpdate(); }, 3_000);
    return () => window.clearInterval(timer);
  }, [loadUpdate, update?.job.state]);

  async function checkUpdate() {
    setUpdateBusy('check'); setUpdateError(''); setConfirmation('');
    try { setUpdate(await api.post<UpdateStatus>('/admin/doctor/update/check')); }
    catch (err) { setUpdateError(err instanceof Error ? err.message : 'The update check did not finish.'); }
    finally { setUpdateBusy(null); }
  }

  async function startUpdate() {
    if (!update?.availableVersion) return;
    setUpdateBusy('start'); setUpdateError('');
    try {
      const result = await api.post<{ job: UpdateJob; message: string }>('/admin/doctor/update/start', { version: update.availableVersion, confirm: confirmation });
      setUpdate({ ...update, job: result.job }); setConfirmation('');
    } catch (err) { setUpdateError(err instanceof Error ? err.message : 'The updater could not start.'); }
    finally { setUpdateBusy(null); }
  }

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

      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><CardTitle>Josi updates</CardTitle><p className="mt-1 text-sm text-muted-foreground">Updates never install automatically. Josi backs up first, verifies the new release, and rolls back when it safely can.</p></div>
          {update ? <Badge tone={update.job.state === 'failed' ? 'danger' : update.updateAvailable ? 'primary' : 'ok'}>{update.job.state === 'running' ? 'Updating' : update.updateAvailable ? 'Available' : `v${update.currentVersion}`}</Badge> : null}
        </div>
        {updateError ? <div className="mt-3"><ErrorNote>{updateError}</ErrorNote></div> : null}
        {update?.job.state === 'running' ? (
          <div className="mt-3 rounded-md border border-border p-3" role="status"><p className="text-sm font-medium">Updating to {update.job.targetVersion}</p><p className="mt-1 text-sm text-muted-foreground">{update.job.message} Josi may briefly disconnect while its containers restart; this page will reconnect automatically.</p></div>
        ) : update?.job.state === 'rolled_back' || update?.job.state === 'failed' || update?.job.state === 'complete' ? (
          <p className="mt-3 text-sm" role="status">{update.job.message}</p>
        ) : null}
        {update?.updateAvailable && update.availableVersion ? (
          <div className="mt-4 rounded-md border border-primary/40 p-3">
            <p className="text-sm font-medium">Version {update.availableVersion} is available</p>
            {update.release?.name ? <p className="mt-1 text-sm text-muted-foreground">{update.release.name}</p> : null}
            {update.release?.notes ? <pre className="mt-3 max-h-44 overflow-auto whitespace-pre-wrap rounded bg-secondary/40 p-3 text-xs">{update.release.notes}</pre> : null}
            {update.release?.url ? <a className="mt-2 inline-block text-sm underline" href={update.release.url} target="_blank" rel="noreferrer">Open release notes</a> : null}
            <label className="mt-4 block text-sm font-medium" htmlFor="update-confirm">Type <span className="font-mono">UPDATE {update.availableVersion}</span> to approve</label>
            <input id="update-confirm" className="mt-2 min-h-11 w-full rounded-md border border-input bg-background px-3 font-mono text-sm" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} disabled={updateBusy !== null} autoComplete="off" />
            <div className="mt-3 flex flex-wrap gap-2"><Button type="button" disabled={updateBusy !== null || confirmation !== `UPDATE ${update.availableVersion}`} onClick={() => void startUpdate()}>{updateBusy === 'start' ? 'Starting…' : `Back up and update to ${update.availableVersion}`}</Button></div>
          </div>
        ) : null}
        <div className="mt-4"><Button type="button" variant="secondary" disabled={updateBusy !== null || update?.job.state === 'running'} onClick={() => void checkUpdate()}>{updateBusy === 'check' || updateBusy === 'load' ? 'Checking…' : 'Check for updates'}</Button></div>
      </Card>

      <div id="doctor-actions">
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
      </div>

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
