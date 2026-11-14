// The first-run wizard.
//
// Phase 3 built the state machine and deliberately left the screens to this
// phase. The important property carried over: **the client never chooses which
// step it is on.** This reads `nextStep` from the server and renders that one.
// Submitting an out-of-order step is refused with 409 whatever this page does,
// so the wizard cannot be walked around by editing a URL or a variable in a
// console.
//
// Secrets typed here — the model API key, the SMTP password — go straight to
// the server and are sealed with the installation master key before they touch
// PostgreSQL. Nothing is kept in component state after the step is submitted.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, clearSetupHandoff, primeCsrf } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import {
  ProviderForm, type ProviderCatalogEntry, type SubscriptionInfo,
} from '@/components/ProviderForm';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { GreetingGhost } from '@/components/ghost/Ghost';
import { LegalLinks } from '@/components/LegalLinks';
import { RestoreBackup } from '@/components/RestoreBackup';

/** The outcome of a real attempt to use something that was configured. */
interface Verification {
  status: 'passed' | 'failed' | 'skipped';
  category?: string | null;
  detail?: string | null;
  target?: string | null;
}

type ReviewStatus =
  | 'configured_and_tested' | 'configured_but_failed' | 'skipped' | 'unavailable' | 'required';

interface ReviewItem {
  key: string;
  label: string;
  required: boolean;
  status: ReviewStatus;
  statusLabel: string;
  blocking: boolean;
  verification: Verification | null;
  unavailableReason?: string | null;
}

interface Review {
  items: ReviewItem[];
  canComplete: boolean;
  headline: string;
  summary?: {
    llm?: { probeSteps?: Array<{ id: string; label: string; passed: boolean; detail: string; substitute?: string }> };
    smtp?: Array<{
      kind: string; host: string | null; port: number | null; security: string | null;
      username: string | null; passwordSet: boolean | null; fromName: string | null;
      fromAddress: string | null;
    }>;
  };
}

/** Which setup step an item is fixed on, so "Edit" can go somewhere. */
const ITEM_STEP: Record<string, string> = {
  llm: 'llm',
  smtp: 'smtp',
};

const STATUS_TONE: Record<ReviewStatus, string> = {
  configured_and_tested: 'text-success',
  configured_but_failed: 'text-destructive',
  skipped: 'text-muted-foreground',
  unavailable: 'text-muted-foreground',
  required: 'text-warning',
};

interface StepDescriptor {
  id: string;
  title: string;
  summary: string;
  skippable: boolean;
  done: boolean;
}

interface SetupState {
  completed: boolean;
  recoveryPending: boolean;
  ownerExists: boolean;
  completedSteps: string[];
  nextStep: string | null;
  steps: StepDescriptor[];
  /** Sent with the state rather than fetched by the model step, so the wizard
   * cannot offer a provider this build would refuse to save. */
  providerCatalog: ProviderCatalogEntry[];
  /** The address chosen in the Linux installer, to prefill the Address step. */
  installerAddress?: InstallerAddress | null;
  /** A model server found on this machine, to prefill the model step. */
  localModel?: { baseUrl: string; model: string } | null;
  /** The Linux server's own PC service, when it is installed. */
  localPc?: LocalPc | null;
}

interface LocalPc { pcId: string; user: string; host: string }

interface InstallerAddress { mode: 'lan' | 'domain' | 'proxy'; origin: string; domain: string; tlsMode: string; acmeEmail: string | null }

interface HostCheck {
  id: string;
  status: 'pass' | 'warn' | 'fail';
  label: string;
  mandatory: boolean;
}

export function Setup({ onDone }: { onDone: () => void }) {
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const [review, setReview] = useState<Review | null>(null);
  /** The first screen offers to restore a backup instead of setting up from nothing. */
  const [restoring, setRestoring] = useState(false);
  /** A completed step the operator has chosen to redo from the review screen. */
  const [revising, setRevising] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await api.get<SetupState>('/setup/state');
    setState(next);
    if (next.completed) { clearSetupHandoff(); onDone(); return; }
    if (next.recoveryPending) setVaultRecovery(await api.get<{key:string;fingerprint:string}>('/setup/vault-recovery'));
    // Only once there is something to summarise. Before the model step there
    // is nothing to say, and an empty summary reads like a broken one.
    if (next.completedSteps.includes('llm')) {
      setReview(await api.get<Review>('/setup/review').catch(() => null as never));
    }
  }, [onDone]);

  async function retest(item: string, body: Record<string, unknown> = {}) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/setup/verify/${item}`, body);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That test could not be run');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void primeCsrf().then(load).catch((err) => setError(err instanceof ApiError ? err.message : 'Could not reach the server')); }, [load]);

  async function submit(step: string, body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const result=await api.post<{vaultRecovery?:{key:string;fingerprint:string}}>(`/setup/steps/${step}`, body);
      if(result.vaultRecovery)setVaultRecovery(result.vaultRecovery);
      if (step === 'llm') {
        await api.post('/setup/verify/llm', {});
      }
      setRevising(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That step could not be saved');
    } finally {
      setBusy(false);
    }
  }

  const [vaultRecovery, setVaultRecovery] = useState<{key:string;fingerprint:string}|null>(null);
  async function finish() {
    setBusy(true);
    setError('');
    try {
      await api.post('/setup/complete');
      clearSetupHandoff();
      onDone();
    } catch (err) {
      // The server refuses while anything required is failing and says which.
      // Reloading brings the summary into line with that answer, so the reason
      // is on screen rather than only in the error line.
      setError(err instanceof ApiError ? err.message : 'Setup could not be completed');
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return <div className="p-6 text-sm text-muted-foreground">{error || 'Loading…'}</div>;
  }
  if(vaultRecovery)return <RecoveryKeyStep recovery={vaultRecovery} onConfirmed={()=>setVaultRecovery(null)} onError={setError}/>;

  const current = state.steps.find((s) => s.id === state.nextStep);
  const revisingStep = revising ? state.steps.find((s) => s.id === revising) : undefined;
  const position = state.completedSteps.length + 1;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl p-5 text-[1.02rem] sm:p-8">
      <div className="mb-6 flex flex-col items-center text-center">
        <div className="mb-3"><GreetingGhost size={120} /></div>
        <p className="text-sm text-muted-foreground">Setting up this installation</p>
      </div>

      {/* Progress, from the server's view of what is done — not from a counter
          this page keeps. */}
      <ol className="mb-4 flex flex-wrap gap-1" aria-label="Setup progress">
        {state.steps.map((s) => (
          <li
            key={s.id}
            className={`h-1.5 min-w-6 flex-1 rounded-full ${s.done ? 'bg-primary' : 'bg-secondary'}`}
            title={s.title}
          />
        ))}
      </ol>

      {error ? <div className="mb-3"><ErrorNote>{error}</ErrorNote></div> : null}

      {restoring ? (
        <Card>
          <CardTitle>Restore a backup</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            Bring back everything from an earlier Josi: people, conversations, settings and, with a protected backup, your connected accounts.
          </p>
          <RestoreBackup mode="setup" onCancel={() => setRestoring(false)} />
        </Card>
      ) : revisingStep ? (
        <Card>
          <CardTitle>{revisingStep.title}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            {revisingStep.summary} Saving this replaces what is stored and tests it again.
          </p>
          <StepForm step={revisingStep.id} busy={busy} catalog={state.providerCatalog ?? []} installerAddress={state.installerAddress} localModel={state.localModel} localPc={state.localPc}
                    smtpInitial={review?.summary?.smtp?.find((profile) => profile.kind === 'system')}
                    onSubmit={submit} />
          <div className="mt-3">
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setRevising(null)}>
              Leave it as it is
            </Button>
          </div>
        </Card>
      ) : current ? (
        <Card>
          <p className="mb-1 text-xs text-muted-foreground">Step {position} of {state.steps.length}</p>
          <CardTitle>{current.title}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">{current.summary}</p>
          <StepForm step={current.id} busy={busy} ownerExists={state.ownerExists} catalog={state.providerCatalog ?? []} installerAddress={state.installerAddress} localModel={state.localModel} localPc={state.localPc} onSubmit={submit} />
        </Card>
      ) : (
        <Card>
          <CardTitle>{review?.canComplete === false ? 'Not ready yet' : 'Ready'}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            {review
              ? review.canComplete
                ? 'Finishing setup is one-way: these screens disappear and the installation starts refusing them.'
                : review.headline
              : 'Finishing setup is one-way: these screens disappear and the installation starts refusing them.'}
          </p>
          {/* Disabled rather than hidden, so the reason stays visible. The
              server refuses it in any case — this is the courtesy, not the
              control. */}
          <Button onClick={() => void finish()} disabled={busy || review?.canComplete === false}>
            {busy ? 'Finishing…' : 'Finish setup'}
          </Button>
        </Card>
      )}

      {!restoring && !revisingStep && !state.ownerExists && state.completedSteps.length === 0 ? (
        <p className="mt-4 text-center text-sm text-muted-foreground">
          Already have a Josi backup?{' '}
          <button type="button" className="text-primary underline" onClick={() => setRestoring(true)}>Restore it instead</button>
        </p>
      ) : null}

      {review && (!current || current.id === 'review') ? (
        <div className="mt-4">
          <ReviewPanel
            review={review}
            busy={busy}
            onRetest={(item, body) => void retest(item, body)}
            onEdit={(step) => void reopen(step)}
          />
        </div>
      ) : null}
      <p className="mt-5 text-center text-xs text-muted-foreground">
        By finishing setup and using Josi, you agree to the Terms and acknowledge the Privacy and Cookie Notices.
      </p>
      <LegalLinks className="mt-2 flex flex-wrap justify-center gap-x-3 gap-y-2 text-xs text-primary [&_a]:underline" />
    </div>
  );

  /** Send the operator back to a step they have already done.
   *
   * Only the three steps that hold configuration for an external service can be
   * revised; the server decides that, not this. Nothing is cleared here — the
   * step's own form is shown again, and submitting it overwrites and re-tests.
   */
  async function reopen(step: string) {
    setError('');
    setRevising(step);
  }
}

function StepForm({
  step, busy, catalog, smtpInitial, onSubmit, ownerExists = false, installerAddress, localPc, localModel,
}: {
  step: string; busy: boolean; catalog: ProviderCatalogEntry[];
  installerAddress?: InstallerAddress | null;
  localPc?: LocalPc | null;
  localModel?: { baseUrl: string; model: string } | null;
  ownerExists?: boolean;
  smtpInitial?: {
    host: string | null; port: number | null; security: string | null; username: string | null;
    passwordSet: boolean | null; fromName: string | null; fromAddress: string | null;
  };
  onSubmit: (step: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [checks, setChecks] = useState<HostCheck[] | null>(null);
  const [showSmtpPassword, setShowSmtpPassword] = useState(false);
  const [smtpUsername, setSmtpUsername] = useState(smtpInitial?.username ?? '');
  const [smtpFromAddress, setSmtpFromAddress] = useState(smtpInitial?.fromAddress ?? '');
  const [smtpFromOverridden, setSmtpFromOverridden] = useState(
    !!smtpInitial?.fromAddress && smtpInitial.fromAddress !== smtpInitial.username,
  );

  useEffect(() => {
    setSmtpUsername(smtpInitial?.username ?? '');
    setSmtpFromAddress(smtpInitial?.fromAddress ?? smtpInitial?.username ?? '');
    setSmtpFromOverridden(!!smtpInitial?.fromAddress && smtpInitial.fromAddress !== smtpInitial.username);
  }, [smtpInitial]);

  useEffect(() => {
    if (step !== 'host_checks') return;
    void api.get<{ checks: HostCheck[] }>('/setup/host-checks').then((r) => setChecks(r.checks)).catch(() => undefined);
  }, [step]);

  function handle(event: React.FormEvent<HTMLFormElement>, build: (f: FormData) => Record<string, unknown>) {
    event.preventDefault();
    void onSubmit(step, build(new FormData(event.currentTarget)));
  }

  switch (step) {
    case 'host_checks':
      return (
        <form onSubmit={(e) => handle(e, () => ({}))} className="space-y-3">
          {checks ? (
            <ul className="space-y-1 text-sm">
              {checks.map((c) => (
                <li key={c.id} className="flex min-w-0 gap-2">
                  <span aria-hidden>{c.status === 'pass' ? '✓' : c.status === 'warn' ? '!' : '✗'}</span>
                  <span className="min-w-0 break-words">{c.label}</span>
                </li>
              ))}
            </ul>
          ) : <p className="text-sm text-muted-foreground">Checking…</p>}
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'owner':
      if (ownerExists) return <form className="space-y-3" onSubmit={(e)=>handle(e,f=>({resumeOwner:true,identifier:f.get('identifier'),password:f.get('password')}))}>
        <p className="text-sm">An owner account is already saved. Sign in to resume without replacing it.</p>
        <Field id="identifier" label="Username or email" required autoComplete="username" />
        <Field id="password" label="Password" type="password" required autoComplete="current-password" />
        <Button type="submit" disabled={busy}>Sign in and continue</Button>
      </form>;
      return (
        <form
          onSubmit={(e) => handle(e, (f) => ({
            email: f.get('email'), username: f.get('username'),
            displayName: f.get('displayName'), password: f.get('password'),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
          }))}
          className="space-y-3"
        >
          <Field id="email" label="Email" type="email" required />
          <Field id="username" label="Username" required autoCapitalize="none" />
          <Field id="displayName" label="Your name" />
          <Field id="password" label="Password" type="password" required
                 autoComplete="new-password" minLength={12} />
          <p className="text-xs text-muted-foreground">At least 12 characters. This is the one administrator account.</p>
          <Button type="submit" disabled={busy}>Create account</Button>
        </form>
      );

    case 'domain':
      return (
        <form
          onSubmit={(e) => handle(e, (f) => ({
            domain: f.get('domain'), tlsMode: f.get('tlsMode'), acmeEmail: f.get('acmeEmail'),
          }))}
          className="space-y-3"
        >
          <Field id="domain" name="domain" label="Address" placeholder="josi.example.com or 192.168.1.20" required autoCapitalize="none" autoComplete="url" inputMode="url" defaultValue={installerAddress?.domain} />
          {installerAddress ? <p className="text-xs text-muted-foreground">Chosen when Josi was installed: {installerAddress.origin}. To change it later, run the installer again.</p> : null}
          <div>
            <label className="mb-1 block text-sm" htmlFor="tlsMode">HTTPS</label>
            <select id="tlsMode" name="tlsMode" defaultValue={installerAddress?.tlsMode ?? 'bundled_caddy'}
                    className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm">
              <option value="bundled_caddy">Bundled Caddy (HTTPS for a public domain, HTTP on LAN)</option>
              <option value="external_proxy">I run my own reverse proxy</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Public certificates require a domain pointing to this server. A LAN IP works over HTTP and needs no certificate email.
          </p>
          <Field id="acmeEmail" name="acmeEmail" label="Email for certificate notices" type="email" autoComplete="email" defaultValue={installerAddress?.acmeEmail ?? undefined} />
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'llm':
      return <LlmStep busy={busy} catalog={catalog} onSubmit={onSubmit} suggested={localModel} />;

    case 'smtp':
      return (
        <EmailStep busy={busy} onSubmit={onSubmit} hasSmtp={!!smtpInitial?.host} smtpForm={
        <form
          onSubmit={(e) => handle(e, (f) => ({
            system: {
              host: f.get('host'), port: Number(f.get('port') || 587), security: f.get('security'),
              username: f.get('username'), password: f.get('password'),
              fromName: f.get('fromName'), fromAddress: f.get('fromAddress'),
            },
            communications: { copyFromSystem: true, fromName: 'Josi', fromAddress: f.get('fromAddress') },
            testTo: f.get('testTo'),
          }))}
          className="space-y-3"
        >
          <Field id="host" label="SMTP server" defaultValue={smtpInitial?.host ?? ''} required autoCapitalize="none" />
          <Field id="port" label="Port" type="number" defaultValue={smtpInitial?.port ?? 587} required />
          <div>
            <label className="mb-1 block text-sm" htmlFor="security">Security</label>
            <select id="security" name="security" defaultValue={smtpInitial?.security ?? 'starttls'}
                    className="min-h-11 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm">
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">None</option>
            </select>
          </div>
          <Field id="username" label="Username" value={smtpUsername} autoCapitalize="none" autoComplete="username"
                 onChange={(event) => {
                   const next = event.currentTarget.value;
                   if (!smtpFromOverridden) setSmtpFromAddress(next);
                   setSmtpUsername(next);
                 }} />
          <div>
            <label className="mb-1 block text-sm" htmlFor="password">Password</label>
            <Input id="password" name="password" type={showSmtpPassword ? 'text' : 'password'}
                   autoComplete="new-password" required={!smtpInitial?.passwordSet}
                   placeholder={smtpInitial?.passwordSet ? 'Leave blank to keep saved password' : undefined} />
            <label className="mt-2 flex min-h-11 items-center gap-2 text-sm">
              <input type="checkbox" checked={showSmtpPassword}
                     onChange={(event) => setShowSmtpPassword(event.target.checked)} />
              Show password
            </label>
          </div>
          <Field id="fromName" label="From name" defaultValue={smtpInitial?.fromName ?? 'Josi'} required />
          <Field id="fromAddress" label="From address" type="email" value={smtpFromAddress} required autoComplete="email"
                 onChange={(event) => {
                   setSmtpFromAddress(event.currentTarget.value);
                   setSmtpFromOverridden(event.currentTarget.value !== smtpUsername);
                 }} />
          <p className="text-xs text-muted-foreground">
            Defaults to the Username. Change it only for an approved alias or shared mailbox.
          </p>
          <Field id="testTo" label="Send a test message to" type="email" required
                 placeholder="you@example.com" />
          <p className="text-xs text-muted-foreground">
            Josi will send one message to that address now. Configuring mail without sending one would
            mean reporting it as working on the strength of the fields being filled in. Your password is
            encrypted with this installation's master key before it is stored, and is kept even if the
            send fails, so fixing a setting does not mean typing it again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>{busy ? 'Testing…' : 'Save and test'}</Button>
            <Button type="button" variant="secondary" disabled={busy}
                    onClick={() => void onSubmit('smtp', { skip: true })}>
              Skip for now
            </Button>
          </div>
        </form>
        } />
      );

    case 'security':
      return (
        <form onSubmit={(e) => handle(e, (f) => ({ folderMappingEnabled: f.get('folders') === 'on' }))} className="space-y-3">
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input type="checkbox" name="folders" defaultChecked className="h-5 w-5" />
            Let people map folders for Josi to read
          </label>
          <p className="text-xs text-muted-foreground">
            You can turn this off later. Folder access is deny-by-default and each person still has to
            consent to their own folders.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'pc_control':
      // A Linux server pairs its own PC service here: the account password is
      // the approval, and control comes on with the everyday allowances.
      if (localPc) return (
        <form onSubmit={(e) => handle(e, (f) => ({ localPcId: localPc.pcId, password: f.get('password'), enable: true }))} className="space-y-3">
          <p className="text-sm">
            Let Josi work on this server as <strong>{localPc.user}</strong> on {localPc.host}: run commands, read and
            write files, open programs{' '}and use her own browser, each within the permissions you give her. Commands,
            deleting, installs and anything high-risk still ask you in chat first.
          </p>
          <Field id="password" name="password" label="Your Josi password" type="password" required autoComplete="current-password" />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>Turn it on</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => void onSubmit('pc_control', { skip: true })}>Skip for now</Button>
          </div>
          <p className="text-xs text-muted-foreground">You can turn it off any time by asking Josi, or under PC control permissions.</p>
        </form>
      );
      // Pairing needs the PC's own key, which only the Josi app on that PC
      // holds; the browser can only skip. The app offers Approve This PC here
      // and later under PC Control.
      return (
        <form onSubmit={(e) => handle(e, () => ({ skip: true }))} className="space-y-3">
          <p className="text-sm">
            Josi can work on the computer where its app is open: run commands, open programs, read and write
            files and use windows, each within the permissions you give it, with a visible control bar and a Stop
            button. Pairing a PC is done from the Josi app on that PC (it holds the PC's key), so from this
            browser the step can only be skipped.
          </p>
          <p className="text-xs text-muted-foreground">
            Nothing is granted by pairing alone. Later, in the Josi app, PC Control shows whether this PC is paired
            and ready, and you can turn control on and allow shells, folders and programs there or by asking Josi.
            On a Linux server, pair the server&rsquo;s own accounts later under PC control permissions, This server.
          </p>
          <Button type="submit" disabled={busy}>Skip for now</Button>
        </form>
      );

    case 'telemetry':
      return (
        <form onSubmit={(e) => handle(e, (f) => ({ enabled: f.get('telemetry') === 'on' }))} className="space-y-3">
          {/* Unchecked. Telemetry is off unless someone affirmatively turns it
              on — a pre-ticked box is not consent. */}
          <label className="flex min-h-11 items-start gap-3 text-sm">
            <input type="checkbox" name="telemetry" className="mt-3 h-5 w-5" />
            <span>Send anonymous usage counts to help improve Josi</span>
          </label>
          <p className="text-xs text-muted-foreground">
            Version, which features are switched on, and error counts. Never prompts, messages, email,
            contacts, calendar entries, credentials, or anything identifying your business. Off unless you
            tick it.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'review':
      return (
        <form onSubmit={(e) => handle(e, () => ({}))} className="space-y-3">
          {/* The summary itself is rendered by ReviewPanel, below the wizard
              card, because it is also what the Finish screen shows. This step
              is just the acknowledgement that you have read it. */}
          <p className="text-sm text-muted-foreground">
            Check the summary below, then continue.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    default:
      return <p className="text-sm text-muted-foreground">Unknown step.</p>;
  }
}

/** What the server says the email step can offer (GET /setup/mail-account). */
interface MailAccountState {
  available: boolean;
  publicAddress: string | null;
  reason: string | null;
  providers: Array<{
    provider: 'google' | 'microsoft';
    configured: boolean;
    clientId: string | null;
    redirectUris: string[];
    connected: { email: string | null; canSend: boolean } | null;
  }>;
  chosen: { provider: 'google' | 'microsoft'; email: string | null; active: boolean } | null;
}

const MAIL_PROVIDER_NAME = { google: 'Google', microsoft: 'Microsoft' } as const;
const MAIL_CONSOLE = {
  google: 'In Google Cloud Console, create an OAuth client of type "Web application" and add both addresses below as authorized redirect URIs.',
  microsoft: 'In Microsoft Entra, register an app, add both addresses below as Web redirect URIs, and create a client secret.',
} as const;
const MAIL_RETURN_PROBLEM: Record<string, string> = {
  declined: 'You cancelled at the provider, so nothing was connected.',
  expired: 'That took too long. Start connecting again.',
  unknown: 'That sign-in was not started from this page. Start connecting again.',
  consumed: 'That sign-in was already used. Start connecting again.',
};

/** The email step. Nothing but the question is shown at first: a Google or
 * Microsoft account, or an SMTP server. Each way's form appears only once it
 * is chosen. Coming back from the provider's sign-in page reopens the account
 * way where it left off. */
function EmailStep({
  busy, onSubmit, smtpForm, hasSmtp,
}: {
  busy: boolean;
  onSubmit: (step: string, body: Record<string, unknown>) => Promise<void>;
  smtpForm: React.ReactNode;
  hasSmtp: boolean;
}) {
  const returned = useMemo(() => new URLSearchParams(window.location.search), []);
  const [way, setWay] = useState<'account' | 'smtp' | null>(returned.has('mail') ? 'account' : hasSmtp ? 'smtp' : null);
  const [state, setState] = useState<MailAccountState | null>(null);
  const [provider, setProvider] = useState<'google' | 'microsoft' | null>(null);
  const [working, setWorking] = useState(false);
  const [note, setNote] = useState<string | null>(
    returned.get('mail') === 'failed'
      ? MAIL_RETURN_PROBLEM[returned.get('reason') ?? ''] ?? 'The account was not connected. Check the client ID, the secret and both redirect addresses, then try again.'
      : null);
  const [editKeys, setEditKeys] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await api.get<MailAccountState>('/setup/mail-account');
      setState(next);
      // Pick up where a return from the provider, or an earlier visit, left off.
      const started = next.chosen?.provider
        ?? next.providers.find((p) => p.connected)?.provider
        ?? next.providers.find((p) => p.configured)?.provider ?? null;
      setProvider((current) => current ?? started);
      if (started && next.available) setWay((current) => current ?? (hasSmtp ? current : 'account'));
    } catch { setState(null); }
  }, [hasSmtp]);
  useEffect(() => { void load(); }, [load]);
  // The answer is read once; a refresh must not show it again.
  useEffect(() => {
    if (returned.has('mail')) window.history.replaceState(null, '', window.location.pathname);
  }, [returned]);

  const current = state?.providers.find((p) => p.provider === provider) ?? null;
  const name = provider ? MAIL_PROVIDER_NAME[provider] : '';

  async function saveKeys(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!provider) return;
    const form = new FormData(event.currentTarget);
    setWorking(true); setNote(null);
    try {
      const result = await api.put<{ ok: boolean; verification: { detail: string } }>(`/setup/mail-account/client/${provider}`,
        { clientId: form.get('clientId'), clientSecret: form.get('clientSecret') });
      setNote(result.ok ? null : result.verification.detail);
      if (result.ok) setEditKeys(false);
      await load();
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'The keys could not be saved.');
    } finally { setWorking(false); }
  }

  async function connect() {
    if (!provider) return;
    setWorking(true); setNote(null);
    try {
      const { url } = await api.post<{ url: string }>('/setup/mail-account/start', { provider });
      window.location.assign(url);
    } catch (err) {
      setNote(err instanceof ApiError ? err.message : 'The sign-in could not be started.');
      setWorking(false);
    }
  }

  if (way === null) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Josi sends a few messages of its own: sign-in codes, password resets and notices to you. Choose how they go out.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <button type="button" disabled={busy || !state?.available} onClick={() => setWay('account')}
                  className="min-h-24 rounded-md border border-border bg-background p-4 text-left disabled:cursor-not-allowed disabled:opacity-60">
            <span className="block text-sm font-semibold">Google or Microsoft account</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              Sign in to your own mailbox. Also turns on "Continue with Google" or "Continue with Microsoft" on the sign-in page.
            </span>
          </button>
          <button type="button" disabled={busy} onClick={() => setWay('smtp')}
                  className="min-h-24 rounded-md border border-border bg-background p-4 text-left disabled:opacity-60">
            <span className="block text-sm font-semibold">SMTP server</span>
            <span className="mt-1 block text-xs text-muted-foreground">
              A mail server address, a username and a password or app password.
            </span>
          </button>
        </div>
        {state && !state.available && state.reason ? (
          <p className="text-xs text-muted-foreground">{state.reason}</p>
        ) : null}
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void onSubmit('smtp', { skip: true })}>
          Skip for now
        </Button>
      </div>
    );
  }

  const back = (
    <button type="button" className="text-sm underline" disabled={busy || working} onClick={() => { setWay(null); setNote(null); }}>
      Choose a different way
    </button>
  );

  if (way === 'smtp') return <div className="space-y-3">{back}{smtpForm}</div>;

  return (
    <div className="space-y-4">
      {back}
      <div className="flex flex-wrap gap-2" role="group" aria-label="Account provider">
        {(['google', 'microsoft'] as const).map((p) => (
          <Button key={p} type="button" variant={provider === p ? 'primary' : 'secondary'} disabled={busy || working}
                  aria-pressed={provider === p} onClick={() => { setProvider(p); setNote(null); setEditKeys(false); }}>
            {MAIL_PROVIDER_NAME[p]}
          </Button>
        ))}
      </div>
      {note ? <ErrorNote>{note}</ErrorNote> : null}

      {provider && current ? (
        <>
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">1. Register Josi with {name}</h3>
            <p className="text-xs text-muted-foreground">{MAIL_CONSOLE[provider]}</p>
            <ul className="space-y-1">
              {current.redirectUris.map((uri) => (
                <li key={uri} className="flex flex-wrap items-center gap-2 text-xs">
                  <code className="break-all rounded bg-muted px-2 py-1">{uri}</code>
                  <button type="button" className="underline" onClick={() => void copyText(uri)}>Copy</button>
                </li>
              ))}
            </ul>
            {current.configured && !editKeys ? (
              <p className="text-sm">
                Keys saved{current.clientId ? ` (client ID starting ${current.clientId.slice(0, 10)}…)` : ''}.{' '}
                <button type="button" className="underline" onClick={() => setEditKeys(true)}>Change</button>
              </p>
            ) : (
              <form onSubmit={(e) => void saveKeys(e)} className="space-y-3">
                <Field id="clientId" label="Client ID" required autoCapitalize="none" autoComplete="off" />
                <Field id="clientSecret" label="Client secret" type="password" required autoComplete="new-password" />
                <p className="text-xs text-muted-foreground">
                  The secret is encrypted with this installation's master key before it is stored.
                </p>
                <Button type="submit" disabled={busy || working}>{working ? 'Checking…' : 'Save keys'}</Button>
              </form>
            )}
          </section>

          {current.configured ? (
            <section className="space-y-2">
              <h3 className="text-sm font-semibold">2. Connect your {name} account</h3>
              {current.connected ? (
                <p className="text-sm">
                  Connected{current.connected.email ? ` as ${current.connected.email}` : ''}.{' '}
                  {current.connected.canSend ? null : `${name} did not allow sending email. Connect again and allow it. `}
                  <button type="button" className="underline" disabled={busy || working} onClick={() => void connect()}>Connect again</button>
                </p>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground">
                    You sign in on {name}'s own page and come back here. Josi never sees your {name} password.
                  </p>
                  <Button type="button" disabled={busy || working} onClick={() => void connect()}>
                    {working ? 'Opening…' : `Connect ${name}`}
                  </Button>
                </>
              )}
            </section>
          ) : null}

          {current.connected?.canSend ? (
            <form className="space-y-3" onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              void onSubmit('smtp', { account: { provider, fromName: form.get('accountFromName') }, testTo: form.get('accountTestTo') });
            }}>
              <h3 className="text-sm font-semibold">3. Send a test message</h3>
              <Field id="accountFromName" label="From name" defaultValue="Josi" required />
              <Field id="accountTestTo" label="Send a test message to" type="email" required
                     defaultValue={current.connected.email ?? ''} placeholder="you@example.com" />
              <p className="text-xs text-muted-foreground">
                Josi will send one message from {current.connected.email ?? `your ${name} account`} now, and its own
                email will go out through that account from then on.
              </p>
              <Button type="submit" disabled={busy || working}>{busy ? 'Testing…' : 'Save and test'}</Button>
            </form>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">Choose Google or Microsoft.</p>
      )}
    </div>
  );
}

/** The model step: the shared provider form, pointed at the wizard's
 * endpoints. The form itself lives in components/ProviderForm.tsx so the admin
 * Model page offers exactly the same choices after installation. */
function LlmStep({
  busy, catalog, onSubmit, suggested,
}: {
  busy: boolean; catalog: ProviderCatalogEntry[];
  onSubmit: (step: string, body: Record<string, unknown>) => Promise<void>;
  suggested?: { baseUrl: string; model: string } | null;
}) {
  return (
    <ProviderForm
      busy={busy}
      catalog={catalog}
      suggested={suggested}
      paths={{
        models: '/setup/models',
        codexBase: '/setup/subscription',
        claudeBase: '/setup/subscription/claude',
        probeProgress: '/setup/models/probe-progress',
      }}
      loadSubscriptionInfo={() => api.get<SubscriptionInfo>('/setup/subscription').catch(() => null)}
      onSubmit={(body) => onSubmit('llm', body)}
      submitLabel="Save and run the five-part test"
    />
  );
}

function RecoveryKeyStep({
  recovery, onConfirmed, onError,
}: {
  recovery: { key: string; fingerprint: string };
  onConfirmed: () => void;
  onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const suffix = recovery.key.slice(-4);

  async function copy() {
    try {
      await copyText(recovery.key);
      setCopied(true);
    } catch {
      onError('The browser could not copy the recovery key. Use Download instead.');
    }
  }

  function download() {
    const blob = new Blob([
      `Josi Vault recovery key\n\n${recovery.key}\n\nFingerprint: ${recovery.fingerprint}\n`,
    ], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `josi-vault-recovery-${recovery.fingerprint}.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return <div className="mx-auto max-w-3xl p-5 sm:p-8"><Card>
    <CardTitle>Save your Vault recovery key</CardTitle>
    <p className="mt-2 text-sm text-muted-foreground">Store this key offline. Josi can show it again while setup is unfinished, until you confirm saving it. Losing both this key and the server&rsquo;s Master Vault key makes encrypted credentials permanently unrecoverable.</p>
    <div className="my-5 rounded-md border border-border bg-background p-4 font-mono text-base" aria-label={`Recovery key ending in ${suffix}`}>
      <span aria-hidden>•••• •••• •••• •••• •••• •••• •••• {suffix}</span>
    </div>
    <p className="text-xs text-muted-foreground">Fingerprint: {recovery.fingerprint}</p>
    <div className="mt-4 flex flex-wrap gap-2">
      <Button type="button" variant="secondary" onClick={()=>void copy()}>{copied ? 'Copied' : 'Copy key'}</Button>
      <Button type="button" variant="secondary" onClick={download}>Download key</Button>
    </div>
    <Button className="mt-4" onClick={()=>void api.post('/setup/vault-recovery-confirmed').then(onConfirmed).catch(e=>onError(e instanceof Error?e.message:'Could not confirm the recovery key'))}>I saved it — continue setup</Button>
  </Card></div>;
}

/** Everything setup decided, and what was actually established about each.
 *
 * The screen this replaces said "Everything is configured. Nothing here has
 * been tested against a live service yet" — two sentences that cannot both be
 * a summary of the same installation. Both the headline and the rows come from
 * one server response now, so they cannot disagree.
 */
function ReviewPanel({
  review, busy, onRetest, onEdit,
}: {
  review: Review;
  busy: boolean;
  onRetest: (item: string, body?: Record<string, unknown>) => void;
  onEdit: (step: string) => void;
}) {
  const [smtpTestTo, setSmtpTestTo] = useState<string | null>(null);

  return (
    <Card>
      <CardTitle>What is set up</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">{review.headline}</p>
      <ul className="space-y-3">
        {review.items.map((item) => (
          <li key={item.key} className="border-t border-border pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{item.label}</span>
              <span className={`text-xs font-medium ${STATUS_TONE[item.status]}`}>
                {item.statusLabel}
              </span>
            </div>

            {item.verification?.detail ? (
              <p className="mt-1 text-xs text-muted-foreground">{item.verification.detail}</p>
            ) : null}
            {item.unavailableReason ? (
              <p className="mt-1 text-xs text-muted-foreground">{item.unavailableReason}</p>
            ) : null}
            {item.key === 'llm' && review.summary?.llm?.probeSteps?.length ? (
              <ul className="mt-2 space-y-1 text-xs" aria-label="Model capability test results">
                {review.summary.llm.probeSteps.map((step) => (
                  <li key={step.id} className="flex gap-2">
                    <span className={step.passed ? 'text-success' : step.substitute ? 'text-muted-foreground' : 'text-warning'} aria-hidden>
                      {step.passed ? '✓' : step.substitute ? '→' : '—'}
                    </span>
                    <span><strong>{step.label}:</strong> {step.detail}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            {item.key === 'smtp' && (
              item.status === 'configured_but_failed'
              || item.status === 'configured_and_tested'
              || (item.status === 'required' && !item.verification)
            ) ? (
              <div className="mt-2 max-w-sm">
                <Field
                  id="smtpRetestTo"
                  label="Send test message to"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                  value={smtpTestTo ?? item.verification?.target ?? ''}
                  onChange={(event) => setSmtpTestTo(event.currentTarget.value)}
                />
              </div>
            ) : null}
            {item.status === 'required' && !item.verification ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {item.blocking
                  ? 'This has to be working before setup can finish.'
                  : 'Nothing has been tested for this yet.'}
              </p>
            ) : null}

            {item.status !== 'unavailable' ? (
              <div className="mt-2 flex flex-wrap gap-2">
                {ITEM_STEP[item.key] ? (
                  <Button type="button" variant="secondary" disabled={busy}
                          onClick={() => onEdit(ITEM_STEP[item.key])}>
                    Change
                  </Button>
                ) : null}
                {item.status === 'configured_but_failed' || item.status === 'configured_and_tested' ? (
                  <Button type="button" variant="secondary"
                          disabled={busy || (item.key === 'smtp'
                            && !(smtpTestTo ?? item.verification?.target ?? '').includes('@'))}
                          onClick={() => onRetest(item.key, item.key === 'smtp'
                            ? { to: smtpTestTo ?? item.verification?.target ?? '' }
                            : {})}>
                    Test again
                  </Button>
                ) : null}
                {/* A required item that has never been tested needs a way to BE
                    tested. Offering only "Change" here was a dead end: the
                    server refuses to finish until a test passes, and the screen
                    provided no way to run one. */}
                {item.status === 'required' && !item.verification && ITEM_STEP[item.key] ? (
                  <Button type="button" disabled={busy || (item.key === 'smtp' && !(smtpTestTo ?? '').includes('@'))}
                          onClick={() => onRetest(item.key, item.key === 'smtp' ? { to: smtpTestTo ?? '' } : {})}>
                    Test
                  </Button>
                ) : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Field({
  id, label, ...props
}: { id: string; label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label className="mb-1 block text-sm" htmlFor={id}>{label}</label>
      <Input id={id} name={id} {...props} />
    </div>
  );
}
