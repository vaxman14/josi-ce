import { useEffect, useState } from 'react';
import type { ProtectedDeviceInventory, VaultRecordReference } from '@josi-ce/core';
import { api } from '@/lib/api';
import { Button, ErrorNote, Input } from './ui';

type RuleChange = { kind: 'cardinal.activate'; draft: VaultRecordReference; policy: VaultRecordReference | null }
  | { kind: 'cardinal.retire'; ruleId: string; policy: VaultRecordReference }
  | { kind: 'device.revoke'; enrollmentId: string; expected: VaultRecordReference };
interface NativeBridge {
  platform: string;
  protectedChanges?: {
    available(): Promise<boolean>;
    review(challengeId: string): Promise<{ status: 'applied' | 'cancelled' | 'unavailable' | 'uncertain'; message: string }>;
  };
}
function bridge() { return (window as Window & { josiDesktop?: NativeBridge }).josiDesktop; }
export function NativeProtectedChange({ title, change, devices, enabled, refreshed }: {
  title: string; change: RuleChange; devices?: ProtectedDeviceInventory; enabled: boolean; refreshed(): Promise<void>;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('');
  const [deviceId, setDeviceId] = useState(''), [password, setPassword] = useState(''), [mfaCode, setMfaCode] = useState('');
  const serialized = JSON.stringify(change);
  const native = bridge(), hasNative = native?.platform === 'darwin' && !!native.protectedChanges;
  const enrolled = devices?.devices.filter(value => !value.revokedAt && value.identity.serverOrigin === window.location.origin) ?? [];
  const ready = enabled && hasNative && enrolled.length > 0 && devices?.reconciliationRequired === false;
  useEffect(() => { setOpen(false); setPassword(''); setMfaCode(''); setError(''); setResult(''); }, [serialized]);
  async function submit() {
    if (busy || !ready || !deviceId || !password || !native?.protectedChanges) return;
    setBusy(true); setError(''); setResult('');
    let challengeId: string | null = null, nativeStarted = false;
    try {
      if (!await native.protectedChanges.available()) throw new Error('Protected confirmation requires the installed Josi app and supported biometric authentication on this Mac.');
      const prepared = await api.post<{ challengeId: string }>('/admin/automation/protected/prepare', {
        deviceId, change, password, mfaCode,
      });
      challengeId = prepared.challengeId; setPassword(''); setMfaCode('');
      nativeStarted = true;
      const response = await native.protectedChanges.review(prepared.challengeId);
      if (!['applied', 'cancelled', 'unavailable', 'uncertain'].includes(response?.status)) throw new Error('The native review result is unavailable. Refresh current settings before trying again.');
      if (response.status === 'applied') { setOpen(false); setResult('Saved to the Vault.'); }
      else if (response.status === 'cancelled') setResult('No protected change was submitted.');
      else if (response.status === 'uncertain') setError('The server response was not confirmed. Check the refreshed settings before starting another review; the change may have been saved.');
      else setError('The protected review could not finish. Check the selected device and current settings, then start a new review.');
      await refreshed();
    } catch (cause) {
      // Once native work starts it owns cancellation and lost-response handling.
      // Never resend a native commit or convert an IPC failure to "not saved".
      if (challengeId && !nativeStarted) {
        try { await api.post(`/admin/automation/protected/${challengeId}/cancel`); } catch { /* Review expires. */ }
      }
      setError(nativeStarted ? 'The native result could not be confirmed. Refresh current settings before starting another review.'
        : cause instanceof Error ? cause.message : 'The protected review could not be prepared.');
      if (nativeStarted) await refreshed();
    } finally { setBusy(false); setPassword(''); setMfaCode(''); }
  }
  return <div className="mt-3 space-y-2">
    <Button variant="secondary" disabled={!ready || busy} onClick={() => { setOpen(!open); setError(''); setResult(''); }}>{title}</Button>
    {!hasNative ? <p className="text-xs text-muted-foreground">Open this server in the installed Josi Mac app for protected approval.</p>
      : !enrolled.length ? <p className="text-xs text-muted-foreground">An enrolled confirmation device for this server is required.</p>
      : !enabled ? <p className="text-xs text-muted-foreground">This server does not support the native approval flow yet.</p> : null}
    {open ? <form onSubmit={event => { event.preventDefault(); void submit(); }} className="space-y-3 rounded-lg border border-border p-3">
      <p className="text-sm text-muted-foreground">Verify your administrator account, then review the exact change in Josi’s separate confirmation window. Device authentication alone does not approve the change.</p>
      <fieldset disabled={busy} className="space-y-3">
        <label className="block text-sm">Confirmation device
          <select required value={deviceId} onChange={event => setDeviceId(event.target.value)} className="mt-1 min-h-11 w-full rounded-lg border border-border bg-background px-3 text-base">
            <option value="">Choose the enrolled Mac you are using</option>
            {enrolled.map(device => <option key={device.enrollmentId} value={device.identity.deviceId}>{device.label}</option>)}
          </select>
        </label>
        <label className="block text-sm">Administrator password
          <Input type="password" required autoComplete="current-password" value={password} maxLength={4096} onChange={event => setPassword(event.target.value)} />
        </label>
        <label className="block text-sm">Authenticator code, if enabled
          <Input inputMode="numeric" autoComplete="one-time-code" value={mfaCode} maxLength={200} onChange={event => setMfaCode(event.target.value)} />
        </label>
        <Button type="submit" disabled={busy || !ready || !deviceId || !password}>{busy ? 'Waiting for native confirmation…' : 'Review in Josi'}</Button>
      </fieldset>
    </form> : null}
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    {result ? <p role="status" className="text-sm text-muted-foreground">{result}</p> : null}
  </div>;
}
