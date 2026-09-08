// Developer services: GitHub, Netlify, Vercel, Supabase.
//
// One page, because "where do I connect GitHub?" should have one answer. It is
// deliberately NOT the Connections page: that page is OAuth accounts with a
// consent screen and per-capability switches, and this one is a personal access
// token somebody pastes. Presenting them as the same thing would teach people
// that a token they paste here was scoped by a provider consent screen, which
// it was not.
//
// What the page must never do:
//
//   * Show a service as connected when nobody connected it. There is no
//     preset, no default and no "configured elsewhere" state — a service is
//     disconnected until a person pastes a token that the provider accepted.
//   * Show a token, or anything derived from one. The connected card shows a
//     fixed mask and the account name the provider reported.
//   * Ask for a permission before saying what it is for. The minimum
//     permissions and, where a provider cannot scope a token at all, the plain
//     warning that it cannot, are ABOVE the field, not under a disclosure.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface DevConnection {
  id: string;
  service: string;
  account: string | null;
  projectRef: string | null;
  reportedScopes: string | null;
  tokenMask: string;
  status: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastErrorCategory: string | null;
  connectedAt: string;
  updatedAt: string;
}

interface DevServiceView {
  service: string;
  label: string;
  purpose: string;
  apiHost: string;
  tokenUrl: string;
  steps: string[];
  minimumPermissions: string[];
  scopeCaveat: string | null;
  reportsScopes: boolean;
  revokeHint: string;
  allowedByAdmin: boolean;
  adminNote: string | null;
  connection: DevConnection | null;
}

const HELP_URL = 'https://josi-ce-docs.netlify.app/#developer-services';

export function DeveloperServices() {
  const [services, setServices] = useState<DevServiceView[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ services: DevServiceView[] }>('/developer-services');
      setServices(res.services);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your developer services');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function connect(view: DevServiceView, token: string, projectRef: string) {
    setBusy(view.service);
    setError('');
    setNotice('');
    try {
      await api.post(`/developer-services/${view.service}`, {
        token,
        projectRef: projectRef.trim() || undefined,
      });
      setNotice(`${view.label} is connected.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not connect ${view.label}`);
    } finally {
      setBusy(null);
    }
  }

  async function test(view: DevServiceView) {
    if (!view.connection) return;
    setBusy(view.service);
    setError('');
    setNotice('');
    try {
      await api.post(`/developer-services/${view.connection.id}/test`);
      setNotice(`${view.label} answered. The connection is working.`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `${view.label} did not answer`);
    } finally {
      setBusy(null);
      await load();
    }
  }

  async function disconnect(view: DevServiceView) {
    if (!view.connection) return;
    setBusy(view.service);
    setError('');
    setNotice('');
    try {
      const res = await api.del<{ note?: string }>(`/developer-services/${view.connection.id}`);
      setNotice(res?.note ?? `${view.label} is disconnected.`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : `Could not disconnect ${view.label}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Developer services</h1>
      <p className="text-sm text-muted-foreground">
        GitHub, Netlify, Vercel and Supabase. Nothing here is set up in advance: each one is
        disconnected until you paste a token of your own, and the token belongs to your account
        alone — not to this installation and not to anyone else who uses it. An administrator can
        see whether your connection is working and can cut it off, but cannot read it.
      </p>
      <p className="text-sm text-muted-foreground">
        These are separate from your Google or Microsoft account under <strong>Connections</strong>,
        from the model your assistant uses, and from messaging <strong>Channels</strong>.{' '}
        <a className="underline" href={HELP_URL} target="_blank" rel="noreferrer noopener">
          Read the help page for developer services
        </a>
        .
      </p>

      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? (
        <p role="status" className="text-sm text-emerald-300">{notice}</p>
      ) : null}
      {!services ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {services?.map((view) => (
        <ServiceCard
          key={view.service}
          view={view}
          busy={busy === view.service}
          onConnect={(token, projectRef) => connect(view, token, projectRef)}
          onTest={() => test(view)}
          onDisconnect={() => disconnect(view)}
        />
      ))}
    </div>
  );
}

function ServiceCard({
  view, busy, onConnect, onTest, onDisconnect,
}: {
  view: DevServiceView;
  busy: boolean;
  onConnect: (token: string, projectRef: string) => Promise<void>;
  onTest: () => Promise<void>;
  onDisconnect: () => Promise<void>;
}) {
  // `replacing` is what makes reconnect a deliberate act rather than a form
  // sitting open under a working connection with a token in it.
  const [replacing, setReplacing] = useState(false);
  const connection = view.connection;

  return (
    <Card>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <CardTitle>{view.label}</CardTitle>
        {connection ? (
          <Badge tone={connection.status === 'active' ? 'ok' : 'danger'}>
            {plain('connection_status', connection.status)}
          </Badge>
        ) : (
          <Badge>Not connected</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{view.purpose}</p>

      {/* The administrator's ceiling. Deny-only, so this state means "switched
          off for everyone", never "switched on for you". */}
      {!view.allowedByAdmin ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm text-muted-foreground">
            An administrator has switched {view.label} off for this installation.
            {view.adminNote ? ` ${view.adminNote}` : ''}
          </p>
          {/* A ceiling stops a credential being used; it must never trap one
              here. Taking your own token back is always available. */}
          {connection ? (
            <>
              <p className="text-sm text-muted-foreground">
                Josi still holds your token and will not use it. You can take it back at any time.
              </p>
              <Button variant="danger" onClick={() => void onDisconnect()} disabled={busy}>
                Disconnect
              </Button>
              <p className="text-sm text-muted-foreground">
                Disconnecting deletes Josi&rsquo;s copy of the token. It cannot revoke it for you:{' '}
                {view.revokeHint}
              </p>
            </>
          ) : null}
        </div>
      ) : connection && !replacing ? (
        <ConnectedState
          view={view}
          connection={connection}
          busy={busy}
          onTest={onTest}
          onDisconnect={onDisconnect}
          onReplace={() => setReplacing(true)}
        />
      ) : (
        <ConnectForm
          view={view}
          busy={busy}
          replacing={replacing}
          onCancel={replacing ? () => setReplacing(false) : null}
          onSubmit={async (token, projectRef) => {
            await onConnect(token, projectRef);
            setReplacing(false);
          }}
        />
      )}
    </Card>
  );
}

function ConnectedState({
  view, connection, busy, onTest, onDisconnect, onReplace,
}: {
  view: DevServiceView;
  connection: DevConnection;
  busy: boolean;
  onTest: () => Promise<void>;
  onDisconnect: () => Promise<void>;
  onReplace: () => void;
}) {
  return (
    <div className="mt-3 space-y-2">
      <dl className="space-y-1 text-sm">
        {connection.account ? (
          <div className="flex min-w-0 flex-wrap gap-2">
            <dt className="text-muted-foreground">Account</dt>
            <dd className="min-w-0 break-words font-medium">{connection.account}</dd>
          </div>
        ) : null}
        {connection.projectRef ? (
          <div className="flex min-w-0 flex-wrap gap-2">
            <dt className="text-muted-foreground">Project</dt>
            <dd className="min-w-0 break-all font-medium">{connection.projectRef}</dd>
          </div>
        ) : null}
        <div className="flex min-w-0 flex-wrap gap-2">
          <dt className="text-muted-foreground">Token</dt>
          {/* A constant mask. Josi keeps the token sealed and cannot show it
              again — nor can anyone else, which is the point. */}
          <dd className="min-w-0 break-all font-mono">{connection.tokenMask}</dd>
        </div>
        <div className="flex min-w-0 flex-wrap gap-2">
          <dt className="text-muted-foreground">Last checked</dt>
          <dd className="min-w-0">
            {connection.lastCheckAt ? new Date(connection.lastCheckAt).toLocaleString() : 'not yet'}
          </dd>
        </div>
        {view.reportsScopes ? (
          <div className="flex min-w-0 flex-wrap gap-2">
            <dt className="text-muted-foreground">Permissions {view.label} reports</dt>
            <dd className="min-w-0 break-words">
              {connection.reportedScopes
                ?? 'this token does not report its permissions, which is normal for a fine-grained token'}
            </dd>
          </div>
        ) : null}
      </dl>

      {connection.lastErrorCategory ? (
        <p className="text-sm text-destructive">
          {plain('connector_error', connection.lastErrorCategory)}
          {plainDetail('connector_error', connection.lastErrorCategory)
            ? ` — ${plainDetail('connector_error', connection.lastErrorCategory)}`
            : ''}
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button variant="secondary" onClick={() => void onTest()} disabled={busy}>
          {busy ? 'Testing…' : 'Test connection'}
        </Button>
        <Button variant="secondary" onClick={onReplace} disabled={busy}>
          Replace token
        </Button>
        <Button variant="danger" onClick={() => void onDisconnect()} disabled={busy}>
          Disconnect
        </Button>
      </div>
      <p className="text-sm text-muted-foreground">
        Disconnecting deletes Josi&rsquo;s copy of the token. It cannot revoke it for you:{' '}
        {view.revokeHint}
      </p>
    </div>
  );
}

function ConnectForm({
  view, busy, replacing, onCancel, onSubmit,
}: {
  view: DevServiceView;
  busy: boolean;
  replacing: boolean;
  onCancel: (() => void) | null;
  onSubmit: (token: string, projectRef: string) => Promise<void>;
}) {
  const [token, setToken] = useState('');
  const [projectRef, setProjectRef] = useState('');
  const tokenFieldId = `${view.service}-token`;
  const projectFieldId = `${view.service}-project`;
  const canSubmit = token.trim().length > 0 && !busy;

  return (
    <form
      className="mt-3 space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        void onSubmit(token, projectRef).then(() => setToken(''));
      }}
    >
      <div>
        <p className="text-sm font-medium">How to create the token</p>
        <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          {view.steps.map((step) => <li key={step}>{step}</li>)}
        </ol>
        <p className="mt-2 text-sm">
          <a className="underline" href={view.tokenUrl} target="_blank" rel="noreferrer noopener">
            Open {view.label} to create it
          </a>
        </p>
      </div>

      <div>
        <p className="text-sm font-medium">The least this token needs</p>
        <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
          {view.minimumPermissions.map((line) => <li key={line}>{line}</li>)}
        </ul>
        {/* Where a provider cannot scope a token, saying so is the honest part.
            Josi is not able to request less than the provider offers, and
            implying otherwise would be a promise it cannot keep. */}
        {view.scopeCaveat ? (
          <p className="mt-2 rounded-md border border-border bg-secondary/40 p-3 text-sm">
            {view.scopeCaveat}
          </p>
        ) : null}
      </div>

      <label className="block text-sm" htmlFor={tokenFieldId}>
        <span className="mb-1 block font-medium">
          {replacing ? `New ${view.label} token` : `${view.label} token`}
        </span>
        <Input
          id={tokenFieldId}
          name={tokenFieldId}
          type="password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          // `new-password` for the same reason the setup wizard uses it: a
          // browser password manager will otherwise offer to fill — and to
          // save — an unrelated credential in this field.
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-describedby={`${tokenFieldId}-help`}
        />
        <span id={`${tokenFieldId}-help`} className="mt-1 block text-xs text-muted-foreground">
          Sent once to {view.apiHost} to check it works, then stored encrypted. Josi never shows it
          again, in chat or anywhere else.
        </span>
      </label>

      {view.service === 'supabase' ? (
        <label className="block text-sm" htmlFor={projectFieldId}>
          <span className="mb-1 block font-medium">Project reference (optional)</span>
          <Input
            id={projectFieldId}
            name={projectFieldId}
            type="text"
            value={projectRef}
            onChange={(e) => setProjectRef(e.target.value)}
            placeholder="twenty lowercase letters"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
          />
        </label>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!canSubmit}>
          {busy ? 'Checking…' : replacing ? `Save new ${view.label} token` : `Connect ${view.label}`}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}
