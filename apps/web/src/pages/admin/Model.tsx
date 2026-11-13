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
import { Badge, Button, Card, CardTitle, CollapsibleCard, ErrorNote, Copyable, Working } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';
import {
  ProviderForm, type ProviderCatalogEntry, type SubscriptionInfo,
} from '@/components/ProviderForm';

interface Provider {
  provider: string;
  model: string;
  active: boolean;
  probedAt: string | null;
  capabilities: { chat: boolean; structuredOutput: boolean; toolCalling: boolean; contextTokens: number | null } | null;
  probeSteps: Array<{ id: string; label: string; passed: boolean; detail: string; substitute?: string }>;
}

interface PromptSize { system: number; tools: number; history: number; latest: number; total: number; measured: boolean }
interface ModelRequest { id: string; at: string; purpose: string; model: string; inputTokens: number; outputTokens: number; latencyMs: number | null; tokensPerSecond: number | null }

interface AdminLlm {
  primary: Provider | null;
  modelContext?: { tokens: number | null; source: string; trainedMax: number | null; at: string } | null;
  lastPrompt?: (PromptSize & { profile: string; toolsOffered: number; toolsAvailable: number; at: string }) | null;
  promptProfile?: 'full' | 'compact' | null;
  backgroundModelWork?: boolean;
  debugLog?: { on: boolean; file: string; flagFile: string };
  fallback: Provider | null;
  localOnly: boolean;
  disabledFeatures: Array<{ feature: string; reason: string }>;
  subscriptionOptions: Array<{
    id: string; label: string; available: boolean; provider: string | null; reason: string;
  }>;
  edition: { edition: string; capabilities: string[] };
  /** Every provider this build will accept, sent with the page so the form
   * cannot draw one the server would then refuse. */
  providerCatalog: ProviderCatalogEntry[];
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
  const [probing, setProbing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [changeOpen, setChangeOpen] = useState(false);

  const load = () => api.get<AdminLlm>('/admin/llm').then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);


  /** Runs ONLY from the button below.
   *
   * There is deliberately no effect that calls this. The model was tested
   * during setup with a real request, that result is stored on the provider
   * row, and re-running it because a page was opened would spend a real
   * request — and, on a subscription provider, the operator's own quota — to
   * re-establish something already known. */
  async function probe() {
    setProbing(true);
    setError('');
    try {
      await api.post('/admin/llm/providers/primary/probe');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test could not run');
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="page">
      <div>
        <h1 className="page-title">Model</h1>
        <p className="mt-1 text-sm text-muted-foreground">Choose what Josi uses to respond.</p>
      </div>
      {!data ? <Working text="Loading…" /> : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {data ? <>
        <Card className="space-y-4 p-5 sm:p-6">
          <div className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">Currently using</div>
          {data.primary ? <>
            <div className="flex flex-wrap items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-muted-foreground">
                  {data.providerCatalog?.find((p) => p.kind === data.primary?.provider)?.label
                    ?? plain('model_provider', data.primary.provider)}
                </p>
                <p className="break-words text-xl font-semibold tracking-tight">
                  {data.primary.model || (data.primary.provider === 'openai_subscription'
                    ? 'Automatic (Codex chooses)' : data.primary.provider === 'anthropic_subscription'
                      ? 'Automatic (Claude chooses)' : 'Provider default')}
                </p>
              </div>
              <Badge tone={data.primary.active ? 'ok' : 'danger'}>
                {data.primary.active ? 'Working' : 'Not tested'}
              </Badge>
            </div>
            {!data.primary.active ? <p className="text-sm text-muted-foreground">
              Josi will not use this model until it passes a real test.
            </p> : null}
          </> : <p className="text-sm text-muted-foreground">No model is configured yet.</p>}
          <div className="flex flex-wrap gap-2 border-t border-border pt-4">
            <Button type="button" onClick={() => setChangeOpen(true)} disabled={probing || saving}>Change model</Button>
            {data.primary && !data.primary.active ? <Button type="button" variant="secondary"
              onClick={() => void probe()} disabled={probing || saving}>{probing ? 'Testing…' : 'Test this model'}</Button> : null}
          </div>
        </Card>

        {changeOpen ? <Card className="space-y-4 p-5 sm:p-6">
          <div>
            <CardTitle>Change model</CardTitle>
            <p className="text-sm text-muted-foreground">
              Models load automatically. Nothing changes until you save and test.
            </p>
          </div>
          <ChangeModelForm catalog={data.providerCatalog ?? []}
            initialProvider={data.primary?.provider ?? 'openai_compatible'}
            blocked={probing} onBusyChange={setSaving}
            onCancel={() => setChangeOpen(false)}
            onSaved={(passed) => { void load(); if (passed) setChangeOpen(false); }} />
        </Card> : null}

        <CollapsibleCard title="Connection & advanced" summary="Optional. Review connection details or test a working model again." className="text-sm">
          <div className="space-y-5">
            {data.subscriptionOptions.some((o) => o.available && o.provider === 'openai_subscription')
              ? <div className="space-y-2"><h2 className="font-medium">ChatGPT connection</h2><CodexConnection /></div>
              : null}
            {data.primary ? <div className="space-y-2">
              <h2 className="font-medium">Current model details</h2>
              {data.primary.model ? <Copyable label="Model identifier" value={data.primary.model} />
                : <p className="text-muted-foreground">The provider chooses the model automatically.</p>}
              {plainDetail('model_provider', data.primary.provider)
                ? <p className="text-muted-foreground">{plainDetail('model_provider', data.primary.provider)}</p> : null}
              {data.primary.active ? <Button type="button" variant="secondary"
                disabled={probing || saving} onClick={() => void probe()}>{probing ? 'Testing…' : 'Test again'}</Button> : null}
              {Array.isArray(data.primary.probeSteps) && data.primary.probeSteps.length ? <ul className="space-y-1">
                {data.primary.probeSteps.map((s) => <li key={s.id} className="break-words">
                  {s.passed ? '✓' : s.substitute ? '→' : '✗'} {s.label} — {s.detail}
                </li>)}
              </ul> : null}
            </div> : null}
            {data.disabledFeatures.filter((f) => f.feature !== 'chat_vision').length ? <div className="space-y-2">
              <h2 className="font-medium">Unavailable features</h2>
              <ul className="space-y-1 text-muted-foreground">
                {data.disabledFeatures.filter((f) => f.feature !== 'chat_vision').map((f) => <li key={f.feature}>
                  {f.feature.replace(/_/g, ' ')} — {f.reason}
                </li>)}
              </ul>
            </div> : null}
            {data.subscriptionOptions.some((o) => !o.available) ? <div className="space-y-2">
              <h2 className="font-medium">Other subscription options</h2>
              <ul className="space-y-1 text-muted-foreground">
                {data.subscriptionOptions.filter((o) => !o.available).map((o) => <li key={o.id}>
                  {o.label} — {o.reason}
                </li>)}
              </ul>
            </div> : null}
          </div>
        </CollapsibleCard>
        {data.primary ? <SizeAndSpeed data={data} /> : null}
      </> : null}
    </div>
  );
}

const count = (n: number) => n.toLocaleString('en-US');
const PURPOSES: Record<string, string> = {
  assistant_chat: 'Chat reply', probe: 'Model test', 'memory.learn': 'Learning from a message', 'memory.summary': 'Conversation summary',
  'improvement.review': 'Reviewing mistakes', 'attachment.condense': 'Condensing a long attachment', josi_doctor_plan: 'System checkup',
  cardinal_meaning_review: 'Rule wording review',
};

/** How much the model can take in, how much Josi sends, and what each recent
 * request cost. Numbers only: nothing on this card is the content of a request. */
function SizeAndSpeed({ data }: { data: AdminLlm }) {
  const [requests, setRequests] = useState<ModelRequest[] | null>(null);
  const loadRequests = () => api.get<{ requests: ModelRequest[] }>('/admin/llm/requests?limit=40').then((r) => setRequests(r.requests)).catch(() => setRequests([]));
  const context = data.modelContext?.tokens ?? null;
  const last = data.lastPrompt ?? null;
  const local = data.primary?.provider === 'openai_compatible';
  // Room for the reply is part of the context too.
  const tooBig = !!(context && last && last.total + 1024 > context);
  // Requests one chat message made: chat rows with under a minute between them.
  const perMessage = (() => {
    const chats = (requests ?? []).filter((r) => r.purpose === 'assistant_chat');
    if (!chats.length) return null;
    let n = 1;
    for (let i = 1; i < chats.length; i++) {
      if (Date.parse(chats[i - 1].at) - Date.parse(chats[i].at) > 60_000) break;
      n++;
    }
    return n;
  })();
  return (
    <CollapsibleCard title="Size and speed" summary="How much the model can take in, how much Josi sends, and how long each request took." className="text-sm">
      <div className="space-y-4">
        <div className="space-y-1">
          <h2 className="font-medium">Context size</h2>
          {context ? <p>{count(context)} tokens <span className="text-muted-foreground">({data.modelContext?.source})</span></p>
            : <p className="text-muted-foreground">{local ? `Unknown: ${data.modelContext?.source ?? 'run Test again to ask your model server'}.` : 'Set by the provider; Josi does not need to check it.'}</p>}
          {data.modelContext?.trainedMax && data.modelContext.trainedMax !== context
            ? <p className="text-muted-foreground">The model itself supports up to {count(data.modelContext.trainedMax)} tokens.</p> : null}
        </div>
        <div className="space-y-1">
          <h2 className="font-medium">What Josi sends</h2>
          <p>{data.promptProfile === 'compact'
            ? 'Compact prompt: short instructions and only the tools each message needs.'
            : 'Full prompt: all instructions and every tool, each time.'}
            {local ? ' Change it under Change model, Prompt size.' : ''}</p>
          {last ? <>
            <p>Last chat request: <strong>{last.measured ? '' : 'about '}{count(last.total)} tokens</strong>
              {' '}<span className="text-muted-foreground">({last.measured ? 'counted by the model server' : 'estimated'})</span></p>
            <ul className="text-muted-foreground">
              <li>Instructions (system prompt): {count(last.system)}</li>
              <li>Tools ({last.toolsOffered} of {last.toolsAvailable} offered): {count(last.tools)}</li>
              <li>Earlier conversation: {count(last.history)}</li>
              <li>The message itself, with its context: {count(last.latest)}</li>
            </ul>
          </> : <p className="text-muted-foreground">No chat request has been sent with this model yet.</p>}
          {tooBig ? <ErrorNote>
            That request plus room for a reply does not fit the model's context of {count(context!)} tokens.
            {data.promptProfile === 'compact' ? ' Raise the context size on your model server.' : ' Switch Prompt size to Compact, or raise the context size on your model server.'}
          </ErrorNote> : null}
        </div>
        <div className="space-y-1">
          <h2 className="font-medium">Background requests</h2>
          <p className="text-muted-foreground">{data.backgroundModelWork
            ? 'On: after a reply Josi may make extra model requests to learn facts and review mistakes.'
            : 'Off: Josi makes model requests only to answer. Nothing runs in the background, so the model is not interrupted between messages.'}</p>
        </div>
        <div className="space-y-2">
          <h2 className="font-medium">Recent requests</h2>
          {requests === null ? <Button type="button" variant="secondary" onClick={() => void loadRequests()}>Show recent requests</Button>
            : !requests.length ? <p className="text-muted-foreground">No requests recorded yet.</p> : <>
              {perMessage ? <p className="text-muted-foreground">The last chat message took {perMessage} model request{perMessage === 1 ? '' : 's'}.</p> : null}
              <p className="text-muted-foreground">Tokens in is what the model server says it read. A server that kept the start of the previous request reports only the new part, so a small number here means the start was reused.</p>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-muted-foreground"><tr>
                    <th className="py-1 pr-3 font-medium">Time</th><th className="py-1 pr-3 font-medium">Why</th>
                    <th className="py-1 pr-3 font-medium">Tokens in</th><th className="py-1 pr-3 font-medium">Tokens out</th>
                    <th className="py-1 pr-3 font-medium">Seconds</th><th className="py-1 font-medium">Tokens/s</th>
                  </tr></thead>
                  <tbody>{requests.map((r) => <tr key={r.id} className="border-t border-border">
                    <td className="whitespace-nowrap py-1 pr-3">{new Date(r.at).toLocaleTimeString()}</td>
                    <td className="py-1 pr-3">{PURPOSES[r.purpose] ?? r.purpose}</td>
                    <td className="py-1 pr-3 tabular-nums">{count(r.inputTokens)}</td>
                    <td className="py-1 pr-3 tabular-nums">{count(r.outputTokens)}</td>
                    <td className="py-1 pr-3 tabular-nums">{r.latencyMs === null ? '' : (r.latencyMs / 1000).toFixed(1)}</td>
                    <td className="py-1 tabular-nums">{r.tokensPerSecond === null ? '' : count(r.tokensPerSecond)}</td>
                  </tr>)}</tbody>
                </table>
              </div>
              <Button type="button" variant="secondary" onClick={() => void loadRequests()}>Refresh</Button>
            </>}
        </div>
        {data.debugLog ? <div className="space-y-1">
          <h2 className="font-medium">Exact requests and replies</h2>
          <p className="text-muted-foreground">{data.debugLog.on
            ? `Recording is ON. Every request to a model on your own hardware and its raw reply is written to ${data.debugLog.file} on the server. It contains conversations: turn it off when you are done by deleting ${data.debugLog.flagFile}.`
            : `Off. To record the exact request and raw reply of every call for debugging, create the file ${data.debugLog.flagFile} on the server. Nothing is recorded until then.`}</p>
        </div> : null}
      </div>
    </CollapsibleCard>
  );
}

/** The wizard's provider form, pointed at the admin endpoints. */
function ChangeModelForm(
  { catalog, onSaved, initialProvider, onCancel, blocked, onBusyChange }: {
    catalog: ProviderCatalogEntry[]; onSaved: (passed: boolean) => void; initialProvider: string;
    onCancel: () => void; blocked: boolean; onBusyChange: (value: boolean) => void;
  },
) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');


  return (
    <div className="space-y-2">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <ProviderForm
        busy={busy || blocked}
        compact
        onCancel={onCancel}
        initialProvider={initialProvider}
        catalog={catalog}
        paths={{
          models: '/admin/llm/models',
          codexBase: '/admin/llm/subscription',
          claudeBase: '/admin/llm/subscription/claude',
          probeProgress: '/admin/llm/providers/primary/probe/progress',
        }}
        loadSubscriptionInfo={async () => {
          try {
            const llm = await api.get<AdminLlm>('/admin/llm');
            const cli = await api.get<{ cli: CodexStatus }>('/admin/llm/subscription/status')
              .catch(() => null);
            return {
              options: llm.subscriptionOptions,
              cli: cli?.cli ?? { installed: false, signedIn: false, detail: 'Not available on this build.' },
            } satisfies SubscriptionInfo;
          } catch {
            return null;
          }
        }}
        submitLabel={busy ? 'Saving and testing…' : 'Save & test'}
        onSubmit={async (body) => {
          setBusy(true);
          onBusyChange(true);
          setError('');
          let stored = false;
          try {
            await api.put('/admin/llm/providers/primary', body);
            stored = true;
            const test = await api.post<{ provider: Provider | null; result: { fatal: string | null } }>(
              '/admin/llm/providers/primary/probe', {},
            );
            if (!test.provider?.active) {
              onSaved(false);
              setError(`Saved, but the test did not pass. ${test.result?.fatal ?? 'The model could not respond.'}`);
              return;
            }
            onSaved(true);
          } catch (err) {
            if (stored) onSaved(false);
            const reason = err instanceof Error ? err.message : 'The request could not be completed';
            setError(stored ? `Saved, but the test could not run: ${reason}` : `Could not save: ${reason}`);
          } finally {
            setBusy(false);
            onBusyChange(false);
          }
        }}
      />
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
    <div className="space-y-2 rounded-md border border-border p-3">
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
