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
import { SETUP_MODELS } from '@/lib/modelCatalog';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

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

  const load = useCallback(async () => {
    const next = await api.get<SetupState>('/setup/state');
    setState(next);
    if (next.completed) onDone();
  }, [onDone]);

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
      setError(err instanceof ApiError ? err.message : 'Setup could not be completed');
    } finally {
      setBusy(false);
    }
  }

  if (!state) {
    return <div className="p-6 text-sm text-muted-foreground">{error || 'Loading…'}</div>;
  }

  const current = state.steps.find((s) => s.id === state.nextStep);
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

      {current ? (
        <Card>
          <p className="mb-1 text-xs text-muted-foreground">Step {position} of {state.steps.length}</p>
          <CardTitle>{current.title}</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">{current.summary}</p>
          <StepForm step={current.id} busy={busy} onSubmit={submit} />
        </Card>
      ) : (
        <Card>
          <CardTitle>Ready</CardTitle>
          <p className="mb-4 text-sm text-muted-foreground">
            Every step is done. Finishing setup is one-way: these screens disappear and the installation
            starts refusing them.
          </p>
          <Button onClick={() => void finish()} disabled={busy}>
            {busy ? 'Finishing…' : 'Finish setup'}
          </Button>
        </Card>
      )}
    </div>
  );
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
          <p className="text-xs text-muted-foreground">
            Encrypted with this installation's master key before it is stored. Nothing is sent to test it yet.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    case 'connectors':
      return (
        <form onSubmit={(e) => handle(e, () => ({ skip: true }))} className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Google and Microsoft connections need your own OAuth application, and that flow is not in this
            release. Skipping this changes nothing you will need later.
          </p>
          <Button type="submit" disabled={busy}>Skip for now</Button>
        </form>
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
          <p className="text-sm text-muted-foreground">
            Everything is configured. Nothing here has been tested against a live service yet — the model is
            tested from the admin section once you are in.
          </p>
          <Button type="submit" disabled={busy}>Continue</Button>
        </form>
      );

    default:
      return <p className="text-sm text-muted-foreground">Unknown step.</p>;
  }
}

/** The model step, which is the one with a decision in it. */
function LlmStep({
  busy, onSubmit,
}: { busy: boolean; onSubmit: (step: string, body: Record<string, unknown>) => Promise<void> }) {
  const [provider, setProvider] = useState('openai_compatible');
  const external = provider !== 'openai_compatible';
  const choices = provider === 'openai' || provider === 'anthropic' || provider === 'xai'
    ? SETUP_MODELS[provider]
    : null;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        void onSubmit('llm', {
          provider, model: f.get('model'), baseUrl: f.get('baseUrl'),
          apiKey: f.get('apiKey'), externalAcknowledged: f.get('ack') === 'on',
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
          <option value="openai_compatible">Self-hosted (Ollama, vLLM, LM Studio…)</option>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="xai">xAI</option>
        </select>
      </div>

      {choices ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="model">Model</label>
          <select id="model" name="model" defaultValue={choices[0].id} key={provider}
                  className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm">
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>{choice.label} — {choice.note}</option>
            ))}
          </select>
        </div>
      ) : (
        <Field id="model" label="Model name on your self-hosted server" required autoCapitalize="none" />
      )}
      {!external ? (
        <Field id="baseUrl" label="Base URL" placeholder="http://ollama:11434/v1" required autoCapitalize="none" />
      ) : null}
      <Field id="apiKey" label={external ? 'API key' : 'API key (if your server needs one)'}
             type="password" autoComplete="off" required={external} />

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

      <Button type="submit" disabled={busy}>Continue</Button>
    </form>
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
