// The model this installation uses.
//
// Two things this page must never do: claim a model works before it has been
// tested, and offer a subscription option that has no compliant path. Both are
// server-enforced; this reflects them.
//
// Phase 13.3 changed the second one from a blanket refusal to a per-provider
// answer, because half of it stopped being true. The screen no longer decides
// which options are available — the server does, from the edition stamped into
// the build — and each one carries the actual current reason. An option that IS
// available gets a real control; one that is not gets no control at all, and
// never a disabled button that looks pressable.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Copyable } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';
import { ClaudeSignIn } from '@/components/ClaudeSignIn';

interface Provider {
  provider: string;
  model: string;
  active: boolean;
  probedAt: string | null;
  capabilities: { chat: boolean; structuredOutput: boolean; toolCalling: boolean; contextTokens: number | null } | null;
  probeSteps: Array<{ id: string; label: string; passed: boolean; detail: string }>;
}

interface AdminLlm {
  primary: Provider | null;
  fallback: Provider | null;
  localOnly: boolean;
  disabledFeatures: Array<{ feature: string; reason: string }>;
  subscriptionOptions: Array<{
    id: string; label: string; available: boolean; provider: string | null; reason: string;
  }>;
  edition: { edition: string; capabilities: string[] };
}

interface CodexStatus {
  installed: boolean;
  signedIn: boolean;
  detail: string;
}

interface DeviceLoginState {
  state: 'idle' | 'starting' | 'awaiting_approval' | 'signed_in' | 'failed' | 'cancelled';
  challenge: { verificationUrl: string; userCode: string } | null;
  expiresAt: string | null;
  message: string | null;
}

export function AdminModel() {
  const [data, setData] = useState<AdminLlm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get<AdminLlm>('/admin/llm').then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  /** Switches the primary slot to a subscription provider.
   *
   * Deliberately does NOT auto-probe afterwards. The probe runs the operator's
   * own Codex binary, which may not be installed or signed in, and a save that
   * silently fails a probe would read as "saving broke". They press Test next,
   * and get the real reason if it is not ready. */
  async function useSubscription(provider: string) {
    setBusy(true);
    setError('');
    try {
      await api.put('/admin/llm/providers/primary', {
        provider,
        // The CLI decides what it supports; this is the model it is asked for.
        model: 'gpt-5-codex',
        externalAcknowledged: true,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch to that');
    } finally {
      setBusy(false);
    }
  }

  async function probe() {
    setBusy(true);
    setError('');
    try {
      await api.post('/admin/llm/providers/primary/probe');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test could not run');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      {/* The heading renders before the data does. A page that withholds its
          own title until a fetch resolves leaves the person looking at bare
          "Loading…" with no idea where they are, and gives a screen reader
          nothing to announce. */}
      <h1 className="text-xl font-semibold tracking-tight">Model</h1>
      {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {data ? (
        <>

      <Card>
        <CardTitle>Primary</CardTitle>
        {data.primary ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{plain('model_provider', data.primary.provider)}</span>
              <Badge tone={data.primary.active ? 'ok' : 'danger'}>
                {data.primary.active ? 'tested and in use' : 'not tested'}
              </Badge>
            </div>
            {/* LB12.2. The exact model identifier is what a support
                conversation needs and what nobody should have to read to see
                whether their model works. It is one disclosure away, with a
                way to copy it. */}
            <details className="mt-2 text-sm">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                Show technical details
              </summary>
              <div className="mt-2">
                <Copyable label="Model identifier" value={data.primary.model} />
                {plainDetail('model_provider', data.primary.provider) ? (
                  <p className="text-xs text-muted-foreground">
                    {plainDetail('model_provider', data.primary.provider)}
                  </p>
                ) : null}
              </div>
            </details>
            {!data.primary.active ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Josi will not use a model it has not tested. Run the test to see what it can actually do.
              </p>
            ) : null}
            {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
            <div className="mt-3">
              <Button onClick={() => void probe()} disabled={busy}>{busy ? 'Testing…' : 'Test this model'}</Button>
            </div>
            {/* Array.isArray, not `?.length` — a string has a length too,
                which is exactly how a double-encoded jsonb column got past
                this guard and threw on .map. */}
            {Array.isArray(data.primary.probeSteps) && data.primary.probeSteps.length ? (
              <ul className="mt-3 space-y-1 text-sm">
                {data.primary.probeSteps.map((s) => (
                  <li key={s.id} className="flex min-w-0 gap-2">
                    <span aria-hidden>{s.passed ? '✓' : '✗'}</span>
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{s.label}</span> — {s.detail}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No model is configured. It is set during installation.</p>
        )}
      </Card>

      {data.disabledFeatures.length ? (
        <Card>
          <CardTitle>Switched off, and why</CardTitle>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {data.disabledFeatures.map((f) => (
              <li key={f.feature}><span className="font-medium text-foreground">{f.feature.replace(/_/g, ' ')}</span> — {f.reason}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Using a Claude or ChatGPT subscription</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          What each provider currently permits, and nothing more optimistic than that.
          This is a <span className="font-medium text-foreground">{data.edition.edition}</span> build.
        </p>
        <ul className="space-y-4">
          {data.subscriptionOptions.map((o) => (
            <li key={o.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className={o.available ? 'text-sm font-medium' : 'text-sm font-medium text-muted-foreground'}>
                  {o.label}
                </span>
                <Badge tone={o.available ? 'ok' : 'muted'}>
                  {o.available ? 'available' : 'unavailable'}
                </Badge>
              </div>
              {/* For an unavailable option: not a disabled button. There is
                  nothing to press, and the reason is the real one rather than
                  "coming soon". */}
              <p className="mt-1 text-sm text-muted-foreground">{o.reason}</p>
              {o.available && o.provider ? (
                <div className="mt-2 space-y-3">
                  {o.provider === 'openai_subscription' ? <CodexConnection /> : null}
                  {o.provider === 'anthropic_subscription'
                    ? <ClaudeSignIn basePath="/admin/llm/subscription/claude" /> : null}
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() => void useSubscription(o.provider!)}
                  >
                    Use this for the primary model
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
        </>
      ) : null}
    </div>
  );
}

function CodexConnection() {
  const [status, setStatus] = useState<CodexStatus | null>(null);
  const [login, setLogin] = useState<DeviceLoginState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadStatus = () => api.get<{ cli: CodexStatus }>('/admin/llm/subscription/status')
    .then((r) => setStatus(r.cli));

  useEffect(() => { void loadStatus().catch(() => undefined); }, []);
  useEffect(() => {
    if (login?.state !== 'starting' && login?.state !== 'awaiting_approval') return;
    const timer = setInterval(() => {
      void api.get<DeviceLoginState>('/admin/llm/subscription/login').then((next) => {
        setLogin(next);
        if (next.state === 'signed_in') void loadStatus();
      }).catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [login?.state]);

  async function connect() {
    setBusy(true);
    setError('');
    try {
      setLogin(await api.post<DeviceLoginState>('/admin/llm/subscription/login', {}));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ChatGPT sign-in could not be started');
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    setError('');
    try {
      await api.post('/admin/llm/subscription/logout', {});
      setLogin(null);
      await loadStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'ChatGPT could not be disconnected');
    } finally {
      setBusy(false);
    }
  }

  if (!status) return <p className="text-sm text-muted-foreground">Checking Codex…</p>;
  if (!status.installed) return <ErrorNote>{status.detail}</ErrorNote>;

  return (
    <div className="space-y-2 rounded-md border border-input p-3">
      <p className="text-sm font-medium">
        {status.signedIn ? 'Connected to your ChatGPT plan' : 'Not connected to ChatGPT'}
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {login?.challenge ? (
        <>
          <p className="text-sm">
            Open <a className="underline" href={login.challenge.verificationUrl} target="_blank" rel="noreferrer">
              {login.challenge.verificationUrl}
            </a>, sign in, then enter this code:
          </p>
          <Copyable label="One-time code" value={login.challenge.userCode} />
          <p className="text-xs text-muted-foreground">Waiting for approval. This page updates automatically.</p>
        </>
      ) : status.signedIn ? (
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void disconnect()}>
          {busy ? 'Disconnecting…' : 'Disconnect ChatGPT'}
        </Button>
      ) : (
        <Button type="button" disabled={busy} onClick={() => void connect()}>
          {busy ? 'Starting…' : 'Connect ChatGPT'}
        </Button>
      )}
      {login?.state === 'failed' ? <ErrorNote>{login.message ?? 'Sign-in failed.'}</ErrorNote> : null}
    </div>
  );
}
