// Choosing a model provider — the ONE form, wherever it is shown.
//
// This is the setup wizard's model step, extracted so the admin Model page can
// offer exactly the same choices after installation. It used to exist only in
// the wizard, which made the first choice a trap: once a subscription (CLI)
// provider was active, the admin page offered no way back to a self-hosted
// endpoint or an API-key provider. Every provider type is switchable in every
// direction, any time — the same component, pointed at different endpoints.
//
// There is no catalogue of model names here. The credential is entered first
// and the provider is asked what it will honour; see the wizard's history for
// why (`gpt-5.6-luna` was once offered to accounts that had no such model).
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { ClaudeSignIn } from '@/components/ClaudeSignIn';
import { Button, Copyable, ErrorNote, Input } from '@/components/ui';

/** A model the provider said this account may use. Never a list of ours. */
export interface DiscoveredModel {
  id: string;
  label: string;
  recommended: boolean;
  likelyNonChat: boolean;
}

export interface SubscriptionOption {
  id: string;
  label: string;
  available: boolean;
  provider: string | null;
  reason: string;
}

export interface SubscriptionInfo {
  options: SubscriptionOption[];
  cli: { installed: boolean; signedIn: boolean; detail: string };
}

export interface DeviceLoginState {
  state: 'idle' | 'starting' | 'awaiting_approval' | 'signed_in' | 'failed' | 'cancelled';
  challenge: { verificationUrl: string; userCode: string } | null;
  expiresAt: string | null;
  message: string | null;
}

export interface ProviderFormPaths {
  /** POST — model discovery for a credential that has not been stored yet. */
  models: string;
  /** Codex device-flow base: `${codexBase}/login` etc. */
  codexBase: string;
  /** Claude sign-in base, handed to ClaudeSignIn. */
  claudeBase: string;
}

interface ProviderDefinition {
  id: string;
  label: string;
  note: string;
  docsUrl: string;
  configurableBaseUrl?: boolean;
}

export interface ProviderFormProps {
  busy: boolean;
  paths: ProviderFormPaths;
  /** What subscriptions are on offer here, and the CLI's state. Null when the
   * build has none (hosted) or the endpoint is unavailable. */
  loadSubscriptionInfo: () => Promise<SubscriptionInfo | null>;
  onSubmit: (body: Record<string, unknown>) => Promise<void>;
  submitLabel?: string;
}

export function ProviderForm({ busy, paths, loadSubscriptionInfo, onSubmit, submitLabel }: ProviderFormProps) {
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
  const [catalog, setCatalog] = useState<ProviderDefinition[]>([]);

  const external = provider !== 'openai_compatible';
  const isSubscription = provider === 'openai_subscription' || provider === 'anthropic_subscription';
  const selectedDefinition = catalog.find((entry) => entry.id === provider);

  // Only a build whose edition permits it answers this at all. A hosted build
  // 404s and the option never appears — the outermost of four layers, not the
  // control.
  useEffect(() => {
    let cancelled = false;
    void loadSubscriptionInfo().then((info) => { if (!cancelled) setSubscription(info); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const catalogPath = paths.models.replace(/\/providers\/models$/, '/catalog');
    void api.get<{ providers: ProviderDefinition[] }>(catalogPath)
      .then((result) => setCatalog(result.providers))
      .catch(() => undefined);
  }, [paths.models]);

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
      }>(paths.models, { provider, apiKey, baseUrl });
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
  const canDiscover = external
    ? apiKey.length > 0 && (!selectedDefinition?.configurableBaseUrl || baseUrl.length > 0)
    : baseUrl.length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const f = new FormData(event.currentTarget);
        void onSubmit({
          provider, model: chosen || f.get('manualModel') || '', baseUrl,
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
          {(catalog.length ? catalog : [
            { id: 'openai_compatible', label: 'A model on your own hardware', note: '', docsUrl: '' },
            { id: 'openai', label: 'OpenAI', note: '', docsUrl: '' },
            { id: 'anthropic', label: 'Anthropic', note: '', docsUrl: '' },
            { id: 'xai', label: 'xAI', note: '', docsUrl: '' },
          ]).map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          {chatgpt?.available ? (
            <option value="openai_subscription">My ChatGPT plan (no API key)</option>
          ) : null}
          {claude?.available ? (
            <option value="anthropic_subscription">My Claude plan (no API key)</option>
          ) : null}
        </select>
      </div>
      {selectedDefinition ? <p className="text-xs text-muted-foreground">{selectedDefinition.note}</p> : null}

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
      {provider === 'openai_subscription'
        ? <SubscriptionSignIn info={subscription} loginPath={`${paths.codexBase}/login`} /> : null}
      {provider === 'anthropic_subscription' ? <ClaudeSignIn basePath={paths.claudeBase} /> : null}

      {(!external || selectedDefinition?.configurableBaseUrl) && !isSubscription ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="baseUrl">
            {external ? 'Provider deployment endpoint' : 'Address of your model server'}
          </label>
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
          <label className="mb-1 block text-sm" htmlFor="manualModel">Model name on your server</label>
          <Input id="manualModel" name="manualModel" required autoCapitalize="none" />
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

      <Button type="submit" disabled={busy || (!models && !isSubscription)}>
        {submitLabel ?? 'Continue'}
      </Button>
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
function SubscriptionSignIn({ info, loginPath }: { info: SubscriptionInfo | null; loginPath: string }) {
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
      void api.get<DeviceLoginState>(loginPath)
        .then((next) => {
          setLogin(next);
          if (next.state === 'signed_in') setSignedIn(true);
        })
        .catch(() => undefined);
    }, 2500);
    return () => clearInterval(timer);
  }, [login?.state, loginPath]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      setLogin(await api.post<DeviceLoginState>(loginPath, {}));
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
          installation shares your plan and its limits, no cost is reported, and tools work once the
          model test confirms them.
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
