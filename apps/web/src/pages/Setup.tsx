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
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, primeCsrf } from '@/lib/api';
import { ClaudeSignIn } from '@/components/ClaudeSignIn';
import { Button, Card, CardTitle, Copyable, ErrorNote, Input } from '@/components/ui';

/** A model the provider said this account may use. Never a list of ours. */
interface DiscoveredModel {
  id: string;
  label: string;
  recommended: boolean;
  likelyNonChat: boolean;
}

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
}

/** Which setup step an item is fixed on, so "Edit" can go somewhere. */
const ITEM_STEP: Record<string, string> = {
  llm: 'llm',
  smtp: 'smtp',
  connector_google: 'connectors',
  connector_microsoft: 'connectors',
};

interface SubscriptionOption {
  id: string;
  label: string;
  available: boolean;
  provider: string | null;
  reason: string;
}

interface SubscriptionInfo {
  options: SubscriptionOption[];
  cli: { installed: boolean; signedIn: boolean; detail: string };
}

interface DeviceLoginState {
  state: 'idle' | 'starting' | 'awaiting_approval' | 'signed_in' | 'failed' | 'cancelled';
  challenge: { verificationUrl: string; userCode: string } | null;
  expiresAt: string | null;
  message: string | null;
}

const STATUS_TONE: Record<ReviewStatus, string> = {
  configured_and_tested: 'text-emerald-600 dark:text-emerald-400',
  configured_but_failed: 'text-red-600 dark:text-red-400',
  skipped: 'text-muted-foreground',
  unavailable: 'text-muted-foreground',
  required: 'text-amber-600 dark:text-amber-400',
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
  completedSteps: string[];
  nextStep: string | null;
  steps: StepDescriptor[];
}

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
  /** A completed step the operator has chosen to redo from the review screen. */
  const [revising, setRevising] = useState<string | null>(null);

  const load = useCallback(async () => {
    const next = await api.get<SetupState>('/setup/state');
    setState(next);
    if (next.completed) { onDone(); return; }
    // Only once there is something to summarise. Before the model step there
    // is nothing to say, and an empty summary reads like a broken one.
    if (next.completedSteps.includes('llm')) {
      setReview(await api.get<Review>('/setup/review').catch(() => null as never));
    }
  }, [onDone]);

  async function retest(item: string) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/setup/verify/${item}`, {});
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That test could not be run');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void primeCsrf().then(load).catch(() => setError('Could not reach the server')); }, [load]);

  async function submit(step: string, body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      await api.post(`/setup/steps/${step}`, body);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'That step could not be saved');
    } finally {
      setBusy(false);
    }
  }

  async function finish() {
    setBusy(true);
    setError('');
    try {
      await api.post('/setup/complete');
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

  const current = state.steps.find((s) => s.id === state.nextStep);
  const revisingStep = revising ? state.steps.find((s) => s.id === revising) : undefined;
  const position = state.completedSteps.length + 1;

  return (
    <div className="mx-auto w-full min-w-0 max-w-xl p-4">
      <div className="mb-6 flex flex-col items-center text-center">
        <img src="/brand/josi-wordmark.png" alt="Josi" width={200} height={97}
             className="mb-2 h-auto w-40 max-w-full" />
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

      {revisingStep ? (
        <Card>
          <CardTitle>{revisingStep.title}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            {revisingStep.summary} Saving this replaces what is stored and tests it again.
          </p>
          <StepForm step={revisingStep.id} busy={busy} onSubmit={submit} />
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
          <StepForm step={current.id} busy={busy} onSubmit={submit} />
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

      {review ? (
        <div className="mt-4">
          <ReviewPanel
            review={review}
            busy={busy}
            onRetest={(item) => void retest(item)}
            onEdit={(step) => void reopen(step)}
          />
        </div>
      ) : null}
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
  step, busy, onSubmit,
}: { step: string; busy: boolean; onSubmit: (step: string, body: Record<string, unknown>) => Promise<void> }) {
  const [checks, setChecks] = useState<HostCheck[] | null>(null);

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
      return (
        <form
          onSubmit={(e) => handle(e, (f) => ({
            email: f.get('email'), username: f.get('username'),
            displayName: f.get('displayName'), password: f.get('password'),
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
          <Field id="domain" label="Address" placeholder="josi.example.com or 192.168.1.20" required autoCapitalize="none" />
          <div>
            <label className="mb-1 block text-sm" htmlFor="tlsMode">HTTPS</label>
            <select id="tlsMode" name="tlsMode" defaultValue="bundled_caddy"
                    className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm">
              <option value="bundled_caddy">Bundled Caddy (HTTPS for a public domain, HTTP on LAN)</option>
              <option value="external_proxy">I run my own reverse proxy</option>
            </select>
          </div>
          <p className="text-xs text-muted-foreground">
            Public certificates require a domain pointing to this server. A LAN IP works over HTTP and needs no certificate email.
          </p>
          <Field id="acmeEmail" label="Email for certificate notices" type="email" />
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'llm':
      return <LlmStep busy={busy} onSubmit={onSubmit} />;

    case 'smtp':
      return (
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
          <Field id="host" label="SMTP server" required autoCapitalize="none" />
          <Field id="port" label="Port" type="number" defaultValue="587" required />
          <div>
            <label className="mb-1 block text-sm" htmlFor="security">Security</label>
            <select id="security" name="security" defaultValue="starttls"
                    className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm">
              <option value="starttls">STARTTLS</option>
              <option value="tls">TLS</option>
              <option value="none">None</option>
            </select>
          </div>
          <Field id="username" label="Username" autoCapitalize="none" />
          <Field id="password" label="Password" type="password" autoComplete="new-password" />
          <Field id="fromName" label="From name" defaultValue="Josi" required />
          <Field id="fromAddress" label="From address" type="email" required />
          <Field id="testTo" label="Send a test message to" type="email" required
                 placeholder="you@example.com" />
          <p className="text-xs text-muted-foreground">
            Josi will send one message to that address now. Configuring mail without sending one would
            mean reporting it as working on the strength of the fields being filled in. Your password is
            encrypted with this installation's master key before it is stored, and is kept even if the
            send fails, so fixing a setting does not mean typing it again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>Continue</Button>
            <Button type="button" variant="secondary" disabled={busy}
                    onClick={() => void onSubmit('smtp', { skip: true })}>
              Skip for now
            </Button>
          </div>
        </form>
      );

    case 'connectors':
      return <ConnectorStep busy={busy} onSubmit={onSubmit} />;

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

/** The model step.
 *
 * There is no catalogue here any more. This used to render a hardcoded list —
 * `gpt-5.6`, `gpt-5.6-terra`, `gpt-5.6-luna` — that nobody had checked against
 * any account, so an operator could pick one, be told they were configured, and
 * find out at the first real request that it did not exist. The credential is
 * entered first and the provider is asked what it will honour.
 */
function LlmStep({
  busy, onSubmit,
}: { busy: boolean; onSubmit: (step: string, body: Record<string, unknown>) => Promise<void> }) {
  const [provider, setProvider] = useState('openai_compatible');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [models, setModels] = useState<DiscoveredModel[] | null>(null);
  const [discovery, setDiscovery] = useState<{ message: string; unsupported: boolean } | null>(null);
  const [looking, setLooking] = useState(false);
  const [chosen, setChosen] = useState('');
  const [showAll, setShowAll] = useState(false);
  const [showIds, setShowIds] = useState(false);
  const [subscription, setSubscription] = useState<SubscriptionInfo | null>(null);

  const external = provider !== 'openai_compatible';
  const isSubscription = provider === 'openai_subscription' || provider === 'anthropic_subscription';

  // Only a build whose edition permits it answers this at all. A hosted build
  // 404s and the option never appears — which is the outermost of four layers,
  // not the control.
  useEffect(() => {
    void api.get<SubscriptionInfo>('/setup/subscription').then(setSubscription).catch(() => setSubscription(null));
  }, []);

  const chatgpt = subscription?.options.find((o) => o.provider === 'openai_subscription');
  const claude = subscription?.options.find((o) => o.provider === 'anthropic_subscription');

  // Anything that changes which account we are asking invalidates the answer.
  useEffect(() => { setModels(null); setDiscovery(null); setChosen(''); }, [provider, apiKey, baseUrl]);

  async function findModels() {
    setLooking(true);
    setDiscovery(null);
    try {
      const r = await api.post<{
        ok: boolean; unsupported: boolean; models: DiscoveredModel[]; message: string | null;
      }>('/setup/models', { provider, apiKey, baseUrl });
      setModels(r.models);
      setChosen(r.models.find((m) => m.recommended)?.id ?? r.models.find((m) => !m.likelyNonChat)?.id ?? '');
      if (r.message) setDiscovery({ message: r.message, unsupported: r.unsupported });
    } catch (err) {
      setModels([]);
      setDiscovery({
        message: err instanceof ApiError ? err.message : 'The provider could not be reached.',
        unsupported: false,
      });
    } finally {
      setLooking(false);
    }
  }

  const usable = (models ?? []).filter((m) => showAll || !m.likelyNonChat);
  const canDiscover = external ? apiKey.length > 0 : baseUrl.length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        void onSubmit('llm', {
          provider, model: chosen || f.get('manualModel'), baseUrl,
          apiKey, externalAcknowledged: f.get('ack') === 'on',
        });
      }}
      className="space-y-3"
    >
      <div>
        <label className="mb-1 block text-sm" htmlFor="provider">Provider</label>
        <select
          id="provider" value={provider} onChange={(e) => setProvider(e.target.value)}
          className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
        >
          <option value="openai_compatible">A model on your own hardware</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="xai">xAI</option>
          {chatgpt?.available ? (
            <option value="openai_subscription">My ChatGPT plan (no API key)</option>
          ) : null}
          {claude?.available ? (
            <option value="anthropic_subscription">My Claude plan (no API key)</option>
          ) : null}
        </select>
      </div>

      {/* Every subscription option, including the ones that are not on offer,
          with the actual reason. "Coming soon" would be a guess; these are
          policies, and they are current. */}
      {subscription?.options.some((o) => !o.available) ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Can I use a subscription I already pay for?</summary>
          <ul className="mt-1 space-y-2">
            {subscription.options.map((o) => (
              <li key={o.id}>
                <span className="font-medium">{o.label}</span>
                {o.available ? ' — available' : ' — not available'}
                <p className="mt-0.5">{o.reason}</p>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/* Two different flows, and the component matches the CLI rather than
          the other way round: ChatGPT's polls itself, Claude's needs a code
          pasted back. */}
      {provider === 'openai_subscription' ? <SubscriptionSignIn info={subscription} /> : null}
      {provider === 'anthropic_subscription' ? <ClaudeSignIn basePath="/setup/subscription/claude" /> : null}

      {!external && !isSubscription ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="baseUrl">Address of your model server</label>
          <Input id="baseUrl" name="baseUrl" value={baseUrl} autoCapitalize="none" required
                 placeholder="http://ollama:11434/v1" onChange={(e) => setBaseUrl(e.target.value)} />
        </div>
      ) : null}

      {/* No key on the subscription path, and not merely hidden: the server
          refuses one. A key there would bill an API account while the product
          called it a subscription. */}
      {!isSubscription ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="apiKey">
            {external ? 'API key' : 'API key (only if your server needs one)'}
          </label>
          <Input id="apiKey" name="apiKey" type="password" autoComplete="off" value={apiKey}
                 required={external} onChange={(e) => setApiKey(e.target.value)} />
        </div>
      ) : null}

      <div className={isSubscription ? 'hidden' : ''}>
        <Button type="button" variant="secondary" disabled={busy || looking || !canDiscover}
                onClick={() => void findModels()}>
          {looking ? 'Asking…' : models ? 'Look again' : 'Show me my models'}
        </Button>
        {!canDiscover ? (
          <p className="mt-1 text-xs text-muted-foreground">
            {external ? 'Enter your API key first.' : 'Enter your server address first.'}
          </p>
        ) : null}
      </div>

      {discovery ? (
        <p className="text-sm text-muted-foreground">{discovery.message}</p>
      ) : null}

      {models && usable.length ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="model">Model</label>
          <select
            id="model" value={chosen} onChange={(e) => setChosen(e.target.value)}
            className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
          >
            {usable.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}{m.recommended ? ' — suggested' : ''}{m.likelyNonChat ? ' (not a chat model)' : ''}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">
            These are the models your account can use. Josi will send one real message to the one you
            pick before it counts as working.
          </p>

          {/* LB12.2: the exact identifier is what a support conversation needs
              and what nobody should have to read to get through setup. */}
          <div className="mt-2 space-y-1">
            <button type="button" className="text-xs underline" onClick={() => setShowIds((v) => !v)}>
              {showIds ? 'Hide technical details' : 'Show technical details'}
            </button>
            {showIds ? (
              <p className="break-all text-xs text-muted-foreground">
                Model identifier: <code>{chosen}</code>
              </p>
            ) : null}
            {(models ?? []).some((m) => m.likelyNonChat) ? (
              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
                Also show models that are probably not for chat
              </label>
            ) : null}
          </div>
        </div>
      ) : null}

      {models && !models.length && discovery?.unsupported && !external ? (
        // Only when discovery is genuinely impossible, and marked as unverified.
        <div>
          <Field id="manualModel" label="Model name on your server" required autoCapitalize="none" />
          <p className="mt-1 text-xs text-muted-foreground">
            Your server does not publish a model list, so this cannot be checked before it is saved.
            Josi will still send a real message to it before treating it as working.
          </p>
        </div>
      ) : null}

      {/* M89. Not pre-ticked, and the server refuses the step without it. */}
      {external ? (
        <label className="flex min-h-11 items-start gap-3 text-sm">
          <input type="checkbox" name="ack" className="mt-3 h-5 w-5" />
          <span>
            I understand that the data needed for each request leaves this server and is processed under
            this provider's terms.
          </span>
        </label>
      ) : (
        <p className="text-xs text-muted-foreground">
          A model on your own hardware. Nothing leaves this server for it.
        </p>
      )}

      <Button type="submit" disabled={busy || (!models && !isSubscription)}>Continue</Button>
    </form>
  );
}

/** Signing the container's Codex CLI in, using the CLI's own device flow.
 *
 * The operator never types a credential here and Josi never receives one. The
 * CLI prints a link and a one-time code, they approve it in their own browser,
 * and the CLI stores its own login in its own home directory — a dedicated
 * volume, so replacing the container does not sign them out.
 */
function SubscriptionSignIn({ info }: { info: SubscriptionInfo | null }) {
  const [login, setLogin] = useState<DeviceLoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [signedIn, setSignedIn] = useState(info?.cli.signedIn ?? false);

  useEffect(() => { setSignedIn(info?.cli.signedIn ?? false); }, [info?.cli.signedIn]);

  // Poll while the operator is off approving it. Stops as soon as the CLI has
  // decided either way, so a finished login does not keep asking.
  useEffect(() => {
    if (login?.state !== 'awaiting_approval' && login?.state !== 'starting') return;
    const timer = setInterval(() => {
      void api.get<DeviceLoginState>('/setup/subscription/login')
        .then((next) => {
          setLogin(next);
          if (next.state === 'signed_in') setSignedIn(true);
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [login?.state]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      setLogin(await api.post<DeviceLoginState>('/setup/subscription/login', {}));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Sign-in could not be started');
    } finally {
      setBusy(false);
    }
  }

  if (!info?.cli.installed) {
    return (
      <ErrorNote>
        {info?.cli.detail ?? 'The Codex CLI is not available in this installation.'}
      </ErrorNote>
    );
  }

  if (signedIn) {
    return (
      <div className="rounded-md border border-input p-3">
        <p className="text-sm">Signed in to your ChatGPT plan.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Josi will send one real message before treating this as working. Everyone on this
          installation shares your plan and its limits, no cost is reported, and Josi can talk but
          cannot use tools on this path.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2 rounded-md border border-input p-3">
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {login?.challenge ? (
        <>
          <p className="text-sm">
            1. Open <a href={login.challenge.verificationUrl} target="_blank" rel="noreferrer"
                       className="underline">{login.challenge.verificationUrl}</a> and sign in.
          </p>
          <p className="text-sm">2. Enter this code:</p>
          <Copyable label="One-time code" value={login.challenge.userCode} />
          <p className="text-xs text-muted-foreground">
            Waiting for you to approve it. This page notices by itself.
            {login.expiresAt ? ' The code expires shortly; start again for a fresh one.' : ''}
          </p>
          <p className="text-xs text-muted-foreground">
            Only continue if you started this here. If somebody sent you this code, stop.
          </p>
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            You will get a link and a one-time code to approve in your own browser. Josi never sees
            your password and never stores your login — OpenAI's own CLI keeps it, on this server.
          </p>
          <Button type="button" disabled={busy} onClick={() => void start()}>
            {busy ? 'Starting…' : 'Sign in with ChatGPT'}
          </Button>
        </>
      )}

      {login?.state === 'failed' ? <ErrorNote>{login.message}</ErrorNote> : null}
    </div>
  );
}

/** Registering the two OAuth applications.
 *
 * This screen used to say the flow was "not in this release" and offer only a
 * Skip button — which was untrue: the connector system had shipped two phases
 * earlier, and the credentials this step collected were being written to a
 * table nothing read.
 *
 * The instructions are here rather than in the manual because an administrator
 * doing this has two consoles open and needs the exact callback in one of them.
 * Everything they must paste into a provider is shown with a copy control; the
 * rest stays out of the way.
 */
function ConnectorStep({
  busy, onSubmit,
}: { busy: boolean; onSubmit: (step: string, body: Record<string, unknown>) => Promise<void> }) {
  interface Guidance {
    available: boolean;
    reason: string | null;
    providers: Array<{
      provider: 'google' | 'microsoft';
      callbackUri: string;
      scopes: string[];
      console: { name: string; url: string };
    }>;
  }
  const [guidance, setGuidance] = useState<Guidance | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    void api.get<Guidance>('/setup/connector-guidance').then(setGuidance).catch(() => undefined);
  }, []);

  if (!guidance) return <p className="text-sm text-muted-foreground">Loading…</p>;

  // LB5.5. A LAN-only installation is told the requirement, not handed a
  // callback no provider would accept.
  if (!guidance.available) {
    return (
      <form onSubmit={(e) => { e.preventDefault(); void onSubmit('connectors', { skip: true }); }}
            className="space-y-3">
        <p className="text-sm text-muted-foreground">{guidance.reason}</p>
        <Button type="submit" disabled={busy}>Continue without them</Button>
      </form>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Optional. Connecting Google or Microsoft lets each person link their own calendar and mail —
        this registers the application they will connect through. You can do it later instead.
      </p>

      {guidance.providers.map((p) => (
        <div key={p.provider} className="rounded-md border border-input p-3">
          <button type="button" className="flex w-full items-center justify-between text-left text-sm font-medium"
                  onClick={() => setOpen(open === p.provider ? null : p.provider)}>
            <span>{p.provider === 'google' ? 'Google' : 'Microsoft'}</span>
            <span aria-hidden>{open === p.provider ? '−' : '+'}</span>
          </button>

          {open === p.provider ? (
            <form
              className="mt-3 space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                void onSubmit('connectors', {
                  [p.provider]: { clientId: f.get('clientId'), clientSecret: f.get('clientSecret') },
                });
              }}
            >
              <ol className="list-decimal space-y-1 pl-4 text-xs text-muted-foreground">
                <li>
                  Open the <a href={p.console.url} target="_blank" rel="noreferrer" className="underline">
                    {p.console.name}
                  </a> and create an OAuth application for a web application.
                </li>
                <li>Paste the redirect address below into it, exactly as shown.</li>
                <li>Copy the client ID and client secret it gives you back here.</li>
              </ol>

              <Copyable label="Redirect address to register" value={p.callbackUri} />

              <Field id={`${p.provider}-clientId`} name="clientId" label="Client ID" required autoCapitalize="none" />
              <Field id={`${p.provider}-clientSecret`} name="clientSecret" label="Client secret"
                     type="password" autoComplete="off" required />

              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Permissions this will ask each person for</summary>
                <ul className="mt-1 space-y-0.5 break-all">
                  {p.scopes.map((s) => <li key={s}><code>{s}</code></li>)}
                </ul>
                <p className="mt-1">
                  Read-only. Sending mail or changing a calendar is a separate permission, asked for
                  later and only if the person turns it on.
                </p>
              </details>

              <p className="text-xs text-muted-foreground">
                Josi will check these against {p.provider === 'google' ? 'Google' : 'Microsoft'} as soon
                as you save them.
              </p>
              <Button type="submit" disabled={busy}>Save and check</Button>
            </form>
          ) : null}
        </div>
      ))}

      <Button type="button" variant="secondary" disabled={busy}
              onClick={() => void onSubmit('connectors', { skip: true })}>
        Skip for now
      </Button>
    </div>
  );
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
  onRetest: (item: string) => void;
  onEdit: (step: string) => void;
}) {
  return (
    <Card>
      <CardTitle>What is set up</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">{review.headline}</p>
      <ul className="space-y-3">
        {review.items.map((item) => (
          <li key={item.key} className="border-t border-input pt-3 first:border-0 first:pt-0">
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
                  <Button type="button" variant="secondary" disabled={busy}
                          onClick={() => onRetest(item.key)}>
                    Test again
                  </Button>
                ) : null}
                {/* A required item that has never been tested needs a way to BE
                    tested. Offering only "Change" here was a dead end: the
                    server refuses to finish until a test passes, and the screen
                    provided no way to run one. */}
                {item.status === 'required' && !item.verification && ITEM_STEP[item.key] ? (
                  <Button type="button" disabled={busy}
                          onClick={() => onRetest(item.key)}>
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
