import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface Candidate { connectionId: string; provider: 'google' | 'microsoft'; accountEmail: string; canSend: boolean }
interface View {
  account: { provider: 'google' | 'microsoft'; connectionId: string; accountEmail: string | null; fromName: string; active: boolean } | null;
  smtp: { host: string; fromAddress: string | null; fromName: string | null } | null;
  sending: 'account' | 'account_broken' | 'smtp' | 'none';
  candidates: Candidate[];
}
const PROVIDER = { google: 'Google', microsoft: 'Microsoft' } as const;

/** Which account sends Josi's own email: sign-in codes, password resets and
 * notices to the owner. Setup asks once; here the owner sees it and changes it. */
export function MailAccountCard() {
  const [view, setView] = useState<View>();
  const [choice, setChoice] = useState('');
  const [fromName, setFromName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<View>('/admin/mail-account').then(v => { setView(v); setFromName(v.account?.fromName ?? 'Josi'); setChoice(v.account?.connectionId ?? v.candidates.find(c => c.canSend)?.connectionId ?? ''); }).catch(() => undefined);
  }, []);
  if (!view) return null;
  async function run(work: () => Promise<View>) {
    setBusy(true); setError('');
    try { setView(await work()); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  const sendable = view.candidates.filter(c => c.canSend);
  const status = view.sending === 'account' ? `Sent from ${view.account?.accountEmail}`
    : view.sending === 'account_broken' ? 'The chosen account needs reconnecting'
    : view.sending === 'smtp' ? `Sent through the mail server ${view.smtp?.host}` : 'No way to send yet';
  return <Card>
    <CardTitle>Josi&apos;s own email</CardTitle>
    <div className="mb-3 mt-2 flex flex-wrap gap-2">
      <Badge tone={view.sending === 'account' || view.sending === 'smtp' ? 'ok' : 'muted'}>{status}</Badge>
    </div>
    <p className="text-sm text-muted-foreground">
      Sign-in codes, password resets and notices to you go out from here. Choose a Google or Microsoft account you connected, or leave it to a mail server saved in setup.
    </p>
    {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    {sendable.length ? <div className="mt-3 grid gap-3">
      <label className="grid gap-1 text-sm">Account
        <select className="min-h-11 rounded-md border border-input bg-background px-2" value={choice} onChange={e => setChoice(e.target.value)}>
          {sendable.map(c => <option key={c.connectionId} value={c.connectionId}>{PROVIDER[c.provider]}: {c.accountEmail}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm">Name shown on the email<Input value={fromName} onChange={e => setFromName(e.target.value)} maxLength={120} /></label>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || !choice} onClick={() => void run(() => api.put<View>('/admin/mail-account', { connectionId: choice, fromName }))}>
          {view.account ? 'Use this account' : 'Send from this account'}</Button>
        {view.account ? <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.del<View>('/admin/mail-account'))}>Stop using it</Button> : null}
      </div>
    </div> : <p className="mt-3 text-sm text-muted-foreground">
      {view.candidates.length ? 'None of your connected accounts allowed sending email. Connect one again and allow sending.' : 'Connect a Google or Microsoft account first, on the Connections page.'}
      {view.account ? <> <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.del<View>('/admin/mail-account'))}>Stop using the chosen account</Button></> : null}
    </p>}
  </Card>;
}
