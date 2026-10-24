import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, ErrorNote, Input } from './ui';

interface Result { status: 'enrolled' | 'reviewed' | 'cancelled' | 'unavailable' | 'uncertain'; message: string }
interface Bridge {
  platform: string;
  deviceEnrollment?: {
    available(): Promise<boolean>;
    enroll(input: { label: string; password: string; mfaCode: string }): Promise<Result>;
    review(id: string): Promise<Result>;
  };
}
interface Pending {
  id: string; label: string; state: string; expiresAtMs: number; canCancel: boolean;
  identity: { deviceId: string; serverOrigin: string };
}
export function DeviceEnrollment({ enabled, vaultReady, refreshed }: {
  enabled: boolean; vaultReady: boolean; refreshed(): Promise<void>;
}) {
  const native = (window as Window & { josiDesktop?: Bridge }).josiDesktop;
  const hasNative = native?.platform === 'darwin' && !!native.deviceEnrollment;
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [label, setLabel] = useState(''), [password, setPassword] = useState(''), [mfaCode, setMfaCode] = useState('');
  const [pending, setPending] = useState<Pending[]>([]), [pendingError, setPendingError] = useState('');
  useEffect(() => {
    if (!enabled) { setPending([]); return; }
    let active = true, loading = false;
    async function load() {
      if (loading || document.hidden) return;
      loading = true;
      try {
        const value = await api.get<{ requests: Pending[] }>('/admin/automation/devices/enroll/pending');
        if (active) { setPending(value.requests); setPendingError(''); }
      } catch { if (active) { setPending([]); setPendingError('Pending enrollments could not be refreshed.'); } }
      finally { loading = false; }
    }
    void load(); const timer = window.setInterval(() => void load(), 3000);
    document.addEventListener('visibilitychange', load);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', load); };
  }, [enabled]);
  async function action(id?: string) {
    if (busy || !native?.deviceEnrollment || !enabled || !vaultReady) return;
    setBusy(true); setError(''); setMessage('');
    let started = false;
    try {
      if (!await native.deviceEnrollment.available()) throw new Error('Open the installed Josi app on a Mac with supported Touch ID.');
      started = true;
      const operation = id ? native.deviceEnrollment.review(id) : native.deviceEnrollment.enroll({ label: label.trim(), password, mfaCode });
      setPassword(''); setMfaCode('');
      const result = await operation;
      if (!['enrolled', 'reviewed', 'cancelled', 'unavailable', 'uncertain'].includes(result?.status)) throw new Error('The native result was not confirmed.');
      if (result.status === 'enrolled') { setOpen(false); setLabel(''); }
      if (['uncertain', 'unavailable'].includes(result.status)) setError(result.message);
      else setMessage(result.message);
      await refreshed();
    } catch (cause) {
      setError(started ? 'The native result could not be confirmed. Refresh the device list before trying another enrollment.'
        : cause instanceof Error ? cause.message : 'Native enrollment is unavailable.');
      if (started) await refreshed();
    } finally { setBusy(false); setPassword(''); setMfaCode(''); }
  }
  async function cancel(id: string) {
    if (busy) return;
    setBusy(true); setError('');
    try { await api.post(`/admin/automation/devices/enroll/${id}/cancel`); setPending(value => value.filter(item => item.id !== id)); }
    catch { setError('This request could not be cancelled. It may already have ended; refresh its current status.'); }
    finally { setBusy(false); }
  }
  return <div className="mt-4 space-y-3">
    <Button variant="secondary" disabled={!enabled || !hasNative || !vaultReady || busy} onClick={() => { setOpen(!open); setPassword(''); setMfaCode(''); }}>Enroll this Mac</Button>
    <p className="text-sm text-muted-foreground">Approve the exact device in Josi on the Mac running this server. When enrolling a remote Mac, compare the device identity and both fingerprints in its enrollment window.</p>
    {!enabled ? <p className="text-xs text-muted-foreground">This server needs the installed macOS consent helper before it can enroll devices.</p>
      : !hasNative ? <p className="text-xs text-muted-foreground">Use the installed Josi Mac app for device enrollment.</p> : null}
    {open ? <form className="space-y-3 rounded-xl border border-border p-3" onSubmit={event => { event.preventDefault(); void action(); }}>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-sm">Name this Mac<Input required maxLength={120} value={label} onChange={event => setLabel(event.target.value)} autoComplete="off" /></label>
        <label className="block text-sm">Administrator password<Input required type="password" maxLength={4096} value={password} autoComplete="current-password" onChange={event => setPassword(event.target.value)} /></label>
        <label className="block text-sm">Authenticator code, if enabled<Input maxLength={200} value={mfaCode} inputMode="numeric" autoComplete="one-time-code" onChange={event => setMfaCode(event.target.value)} /></label>
        <Button type="submit" disabled={busy || !label.trim() || !password}>{busy ? 'Waiting for native enrollment…' : 'Start protected enrollment'}</Button>
      </fieldset>
    </form> : null}
    <div className="space-y-2">
      <h3 className="font-medium">Pending device enrollments</h3>
      {pendingError ? <ErrorNote>{pendingError}</ErrorNote> : null}
      {!pending.length ? <p className="text-sm text-muted-foreground">No pending enrollment is available for this administrator.</p> : null}
      {pending.map(item => <div key={item.id} className="space-y-2 rounded-xl border border-border p-3">
        <p className="font-medium">{item.label}</p>
        <p className="break-all text-xs text-muted-foreground">Device: {item.identity.deviceId}</p>
        <p className="text-xs text-muted-foreground">{item.state === 'approved' ? 'Server approval received; waiting for the target Mac.' : item.state === 'waiting' ? 'Waiting for approval on the server Mac.' : 'This local review has ended.'} Expires {new Date(item.expiresAtMs).toLocaleTimeString()}.</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy || !hasNative || !vaultReady || item.state !== 'waiting'} onClick={() => void action(item.id)}>Review on server Mac</Button>
          {item.canCancel ? <Button variant="secondary" disabled={busy} onClick={() => void cancel(item.id)}>Cancel request</Button> : null}
        </div>
      </div>)}
    </div>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}
  </div>;
}
