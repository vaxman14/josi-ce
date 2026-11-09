// How much Josi may do without asking, and confirming who you are.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { canUsePasskeys, createPasskey, passkeyMessage } from '@/lib/passkeys';
import { Badge, Button, CollapsibleCard, ErrorNote, Input } from '@/components/ui';
import { AssistantMigration } from '@/pages/AssistantMigration';

const ACTION_CLASSES = [
  { key: 'email_send', label: 'Sending email on your behalf' },
  { key: 'calendar_write', label: 'Creating and changing calendar events' },
  { key: 'contacts_write', label: 'Creating and changing contacts' },
  { key: 'task_management', label: 'Creating and changing tasks' },
];

const LEVELS = [
  { value: 'always_ask', label: 'Always ask me first' },
  { value: 'risky_only', label: 'Ask only for risky or destructive actions' },
  { value: 'automatic', label: 'Allow routine actions automatically' },
];

interface LevelState {
  level: string;
  userChoice: string;
  adminCeiling: string | null;
  managedPolicy: boolean;
}

const LEVEL_RANK: Record<string, number> = { always_ask: 0, risky_only: 1, automatic: 2 };

export function Settings() {
  const [levels, setLevels] = useState<Record<string, LevelState>>({});
  const [error, setError] = useState('');
  const [dataOpen, setDataOpen] = useState(false);

  useEffect(() => {
    for (const cls of ACTION_CLASSES) {
      void api.get<LevelState>(`/assistant/approval-levels/${cls.key}`)
        .then((r) => setLevels((c) => ({ ...c, [cls.key]: r })))
        .catch(() => undefined);
    }
  }, []);

  async function change(actionClass: string, level: string) {
    setError('');
    try {
      const result = await api.put<LevelState>(`/assistant/approval-levels/${actionClass}`, { level });
      setLevels((c) => ({ ...c, [actionClass]: result }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    }
  }

  return (
    <div className="page">
      <h1 className="page-title">Settings</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <CollapsibleCard
        title="What Josi may do without asking"
        summary="Approval behavior for email, calendar, contacts, and tasks"
        status={Object.values(levels).some((state) => state.managedPolicy)
          ? <Badge tone="primary">Admin limits apply</Badge>
          : <Badge tone="muted">Your choices</Badge>}
        defaultOpen
      >
        <p className="mb-3 text-sm text-muted-foreground">
          Some actions always need approval whatever you choose here — adding someone to an existing
          conversation, sending an attachment, and anything that deletes.
        </p>
        <div className="space-y-4">
          {ACTION_CLASSES.map((cls) => {
            const state = levels[cls.key];
            const available = state?.managedPolicy && state.adminCeiling
              ? LEVELS.filter((level) => LEVEL_RANK[level.value] <= LEVEL_RANK[state.adminCeiling!])
              : LEVELS;
            return (
              <div key={cls.key}>
                <label className="mb-1 block text-sm font-medium" htmlFor={`lvl-${cls.key}`}>{cls.label}</label>
                <select
                  id={`lvl-${cls.key}`}
                  aria-describedby={state?.managedPolicy ? `lvl-${cls.key}-managed` : undefined}
                  value={state?.managedPolicy ? state.level : (state?.userChoice ?? 'always_ask')}
                  onChange={(e) => void change(cls.key, e.target.value)}
                  className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm"
                >
                  {available.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                </select>
                {/* M33: an administrator may tighten this and may never loosen
                    it. When they have, the person is told what will actually
                    happen rather than what they asked for. */}
                {state?.managedPolicy ? (
                  <p id={`lvl-${cls.key}-managed`} className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge tone="primary">Managed policy lock</Badge>
                    Maximum allowed: {state.adminCeiling?.replace(/_/g, ' ')}. Choices this lock would ignore are not offered.
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      </CollapsibleCard>

      <CollapsibleCard title="Data & Backup" summary="Migrate your assistant data and manage import batches" open={dataOpen} onOpenChange={setDataOpen}>
        <AssistantMigration onDone={() => setDataOpen(false)} />
      </CollapsibleCard>
      <StepUpCard />
      <PasskeysCard />
      <MfaCard />
    </div>
  );
}

interface PasskeyRow { id: string; name: string; created_at: string; last_used_at: string | null }

/** Sign in with a fingerprint, face or device PIN instead of a password. */
function PasskeysCard() {
  const [state, setState] = useState<{ available: boolean; origin: string | null; passkeys: PasskeyRow[] } | null>(null);
  const [name, setName] = useState(''); const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const load = () => api.get<{ available: boolean; origin: string | null; passkeys: PasskeyRow[] }>('/auth/passkeys').then(setState);
  useEffect(() => { void load().catch(() => undefined); }, []);
  async function add(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await createPasskey(password, name.trim()); setName(''); await load(); }
    catch (e) { setError(passkeyMessage(e, 'Could not add that passkey')); }
    finally { setPassword(''); setBusy(false); }
  }
  async function remove(id: string) {
    setError('');
    try { await api.del(`/auth/passkeys/${id}`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove that passkey'); }
  }
  if (!state?.available) return null;
  const count = state.passkeys.length;
  return <CollapsibleCard title="Passkeys" summary="Sign in with your fingerprint, face or device PIN"
    status={<Badge tone={count ? 'ok' : 'muted'}>{count ? `${count} added` : 'None yet'}</Badge>}>
    <p className="mb-3 text-sm text-muted-foreground">A passkey stays on your device. It is enough to sign in on its own, so your authenticator code is not asked for.</p>
    {count ? <ul className="mb-4 divide-y divide-border">
      {state.passkeys.map(key => <li key={key.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-2">
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{key.name}</span>
          <span className="block text-xs text-text-muted">Added {new Date(key.created_at).toLocaleDateString()}{key.last_used_at ? ` · Last used ${new Date(key.last_used_at).toLocaleDateString()}` : ''}</span>
        </span>
        <Button variant="danger" aria-label={`Remove passkey ${key.name}`} onClick={() => void remove(key.id)}>Remove</Button>
      </li>)}
    </ul> : null}
    {canUsePasskeys(state.origin) ? <form onSubmit={event => void add(event)} className="space-y-3">
      <div>
        <label className="mb-1 block text-sm" htmlFor="passkey-name">Name this passkey</label>
        <Input id="passkey-name" maxLength={80} placeholder="My iPhone" value={name} onChange={event => setName(event.target.value)} required />
      </div>
      <div>
        <label className="mb-1 block text-sm" htmlFor="passkey-password">Your password</label>
        <Input id="passkey-password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required />
      </div>
      <Button type="submit" disabled={busy || !name.trim() || !password}>{busy ? 'Waiting for your device…' : 'Add a passkey'}</Button>
    </form> : <p className="text-sm text-muted-foreground">To add a passkey, open Josi at {state.origin} on a device that supports them.</p>}
    {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
  </CollapsibleCard>;
}

function MfaCard() {
  const [enabled, setEnabled] = useState(false); const [remaining, setRemaining] = useState(0);
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState(''); const [recovery, setRecovery] = useState<string[]>([]); const [error, setError] = useState('');
  const [disablePassword, setDisablePassword] = useState('');
  const [linked, setLinked] = useState(false); const [sharePassword, setSharePassword] = useState(''); const [shareCode, setShareCode] = useState('');
  useEffect(() => { void api.get<{ enabled: boolean; recoveryCodesRemaining: number; heyJosiLinked?: boolean }>('/auth/mfa')
    .then((r) => { setEnabled(r.enabled); setRemaining(r.recoveryCodesRemaining); setLinked(!!r.heyJosiLinked); }); }, []);
  async function share() { setError(''); try { const r = await api.post<{ enabled: boolean; recoveryCodes: string[] }>('/auth/mfa/share', { password: sharePassword, code: shareCode }); setEnabled(true); setRecovery(r.recoveryCodes); setRemaining(r.recoveryCodes.length); setSharePassword(''); setShareCode(''); } catch (e) { setShareCode(''); setError(e instanceof Error ? e.message : 'Could not use that authenticator'); } }
  async function begin() { setError(''); try { setSetup(await api.post('/auth/mfa/setup')); } catch (e) { setError(e instanceof Error ? e.message : 'Could not start MFA'); } }
  async function enable() { setError(''); try { const r = await api.post<{ enabled: boolean; recoveryCodes: string[] }>('/auth/mfa/enable', { code }); setEnabled(true); setRecovery(r.recoveryCodes); setRemaining(r.recoveryCodes.length); setSetup(null); } catch (e) { setError(e instanceof Error ? e.message : 'Could not enable MFA'); } }
  async function disable() { setError(''); try { await api.post('/auth/mfa/disable', { password: disablePassword }); setEnabled(false); setRecovery([]); setRemaining(0); setDisablePassword(''); } catch (e) { setError(e instanceof Error ? e.message : 'Could not disable MFA'); } }
  return <CollapsibleCard title="Multi-factor authentication"
    summary="Require an authenticator app when signing in"
    status={<Badge tone={enabled ? 'ok' : 'danger'}>{enabled ? `Enabled · ${remaining} codes` : 'Not enabled'}</Badge>}
    defaultOpen={!enabled}>
    <p className="mb-3 text-sm text-muted-foreground">Use an authenticator app at sign-in. Recovery codes work once each.</p>
    {enabled ? <><p className="mb-3 text-sm text-success">Enabled · {remaining} recovery codes remain</p>
      <div className="flex gap-2"><Input type="password" autoComplete="current-password" placeholder="Confirm password to disable" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} />
      <Button variant="danger" disabled={!disablePassword} onClick={() => void disable()}>Disable MFA</Button></div></> : null}
    {!enabled && !setup && linked ? <div className="mb-4 space-y-2 rounded border border-border p-3"><p className="text-sm font-semibold">Use my Hey Josi authenticator</p>
      <p className="text-sm text-muted-foreground">One authenticator for your whole platform. Turn it on under Security on your Hey Josi account first.</p>
      <Input type="password" autoComplete="current-password" placeholder="Your password on this server" value={sharePassword} onChange={(e) => setSharePassword(e.target.value)} />
      <Input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code from your app" value={shareCode} onChange={(e) => setShareCode(e.target.value)} />
      <Button disabled={!sharePassword || !/^\d{6}$/.test(shareCode)} onClick={() => void share()}>Use it here</Button></div> : null}
    {!enabled && !setup ? <Button onClick={() => void begin()}>Set up MFA</Button> : null}
    {setup ? <div className="space-y-3"><img src={setup.qrDataUrl} alt="Authenticator QR code" className="h-48 w-48 rounded bg-paper p-2" />
      <p className="break-all text-xs">Manual key: {setup.secret}</p><Input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
      <Button onClick={() => void enable()}>Verify and enable</Button></div> : null}
    {recovery.length ? <div className="mt-4 rounded border border-border p-3"><p className="mb-2 text-sm font-semibold">Save these recovery codes now</p>
      <pre className="whitespace-pre-wrap text-sm">{recovery.join('\n')}</pre></div> : null}
    {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
  </CollapsibleCard>;
}

/** Re-authentication before something that cannot be undone.
 *
 * Named for what it is. Confirming a password proves the person at the keyboard
 * is not just someone holding an open session; it does not prove more than
 * that, and the wording does not claim it does. */
function StepUpCard() {
  const [password, setPassword] = useState('');
  const [state, setState] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');

  async function confirm(event: React.FormEvent) {
    event.preventDefault();
    try {
      await api.post('/assistant/step-up', { password });
      setState('ok');
      setMessage('Confirmed for the next 15 minutes on this device.');
    } catch (err) {
      setState('error');
      setMessage(err instanceof Error ? err.message : 'That did not match');
    } finally {
      setPassword('');
    }
  }

  return (
    <CollapsibleCard title="Confirm it is you"
      summary="Re-enter your password before sensitive changes"
      status={state === 'ok' ? <Badge tone="ok">Confirmed for 15 minutes</Badge> : <Badge tone="muted">On demand</Badge>}>
      <p className="mb-3 text-sm text-muted-foreground">
        Cancelling work, changing settings and sharing something with a colleague need your password again,
        so an open session someone else is using cannot do them.
      </p>
      <form onSubmit={confirm} className="space-y-3">
        <div>
          <label className="mb-1 block text-sm" htmlFor="stepup-password">Password</label>
          <Input
            id="stepup-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <Button type="submit">Confirm</Button>
        {state !== 'idle' ? (
          state === 'ok'
            ? <p className="text-sm text-success">{message}</p>
            : <ErrorNote>{message}</ErrorNote>
        ) : null}
      </form>
    </CollapsibleCard>
  );
}
