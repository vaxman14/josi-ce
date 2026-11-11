import { useUnsavedChanges } from '@/lib/useUnsavedChanges';
// Connected accounts.
//
// Phase 6 shipped this page saying plainly that connecting was not available.
// Phase 7 makes it real, and the honesty rule still applies: nothing here is
// pressable unless it works. If an administrator has not registered the
// installation's own OAuth application, the page says so instead of offering a
// Connect button that would fail at the provider.
//
// Every write capability shows what it permits before it can be switched on.
// A toggle labelled only "Send email" is not consent.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, CollapsibleCard, ErrorNote, Input, NotYet, Working } from '@/components/ui';
import { CloudFolders } from '@/components/CloudFolders';
import { McpServers } from '@/components/McpServers';
import { plain } from '@/lib/plainLanguage';

interface Capability {
  key: string;
  label: string;
  kind: 'read' | 'write';
  consequence?: string;
  state: 'needs_consent' | 'blocked_by_admin' | 'off' | 'on';
  needsConsent: boolean;
  adminNote: string | null;
}

type Provider = 'google' | 'microsoft' | 'dropbox' | 'box' | 'nextcloud';
const OAUTH_PROVIDERS: Provider[] = ['google', 'microsoft', 'dropbox', 'box'];

interface ProviderView {
  provider: Provider;
  available: boolean;
  connection: {
    id: string;
    account: string | null;
    status: string;
    lastCheckAt: string | null;
    lastCheckOk: boolean | null;
    errorCategory: string | null;
    /** Nextcloud only: the server address its owner typed. Null for every
     * OAuth provider. */
    serverUrl?: string | null;
    capabilities?: Capability[];
    needsPermissionUpgrade?: boolean;
  } | null;
  connections?: Array<NonNullable<ProviderView['connection']>>;
  capabilities: Capability[];
}

const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Google', microsoft: 'Microsoft 365', dropbox: 'Dropbox', box: 'Box', nextcloud: 'Nextcloud',
};

const STORAGE_CAPABILITY_KEY: Record<Provider, string> = {
  google: 'google.drive.read',
  microsoft: 'microsoft.files.read',
  dropbox: 'dropbox.files.read',
  box: 'box.files.read',
  nextcloud: 'nextcloud.files.read',
};

/** What each failure means to the person who has to fix it. A raw category is
 * not an explanation. */
const ERROR_TEXT: Record<string, string> = {
  revoked: 'Access was withdrawn at the provider. Reconnect to restore it.',
  expired: 'The stored access expired and could not be renewed. Reconnect.',
  insufficient_scope: 'A permission Josi needs was not granted. Reconnect and approve it.',
  rate_limited: 'The provider is rate limiting us. This usually clears on its own.',
  provider_error: 'The provider returned an error. If it persists, reconnect.',
  network: 'Josi could not reach the provider.',
};

export function Connections() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ providers: ProviderView[] }>('/connections');
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your connections');
    }
  }, []);

  useEffect(() => {
    void load();
    // The callback comes back with ?error=… when a handshake was refused.
    const reason = new URLSearchParams(window.location.search).get('error');
    if (reason) setError(handshakeError(reason));
  }, [load]);

  async function connect(provider: string, connectionId?: string) {
    setBusy(provider);
    setError('');
    try {
      const res = await api.post<{ url: string }>(`/connections/${provider}/start`, {
        connectionId, returnPath: '/app/connections',
      });
      // Leaving the app is the point: consent happens at the provider.
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the connection');
      setBusy(null);
    }
  }

  // Nextcloud has no OAuth handshake to leave the page for — the server
  // address, username and app password are submitted directly, verified
  // against the server, and the connection either exists or the form shows
  // why not. No redirect, no callback, no ?error= query string to parse.
  async function connectNextcloud(args: { serverUrl: string; username: string; appPassword: string }) {
    setBusy('nextcloud');
    setError('');
    try {
      await api.post('/connections/nextcloud/connect', args);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not connect to that Nextcloud server');
    } finally {
      setBusy(null);
    }
  }

  async function toggle(view: ProviderView, capability: Capability) {
    if (!view.connection) return;
    // Provider permissions are upgraded once at account level. A capability
    // with a missing scope cannot be toggled until that upgrade completes.
    if (capability.needsConsent) return;
    setBusy(capability.key);
    setError('');
    try {
      await api.put(`/connections/${view.connection.id}/capabilities/${capability.key}`, {
        enabled: capability.state !== 'on',
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(view: ProviderView) {
    if (!view.connection) return;
    setBusy(view.provider);
    setError('');
    try {
      const res = await api.del<{ note?: string }>(`/connections/${view.connection.id}`);
      if (res?.note) setError(res.note);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  }

  const cards = useMemo(() => providers?.flatMap((view) => {
    const accounts = view.connections?.filter(Boolean) ?? [];
    return accounts.length
      ? accounts.map((connection) => ({ ...view, connection, capabilities: connection.capabilities ?? view.capabilities }))
      : [view];
  }) ?? null, [providers]);

  return (
    <div className="page">
      <h1 className="page-title">Connections</h1>
      <p className="text-sm text-muted-foreground">
        Your own account, connected by you. An administrator can see whether a connection is working and
        can disconnect it, but cannot read what is inside it.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!cards ? <Working text="Loading…" /> : null}

      {cards?.map((view) => (
        <CollapsibleCard
          key={`${view.provider}-${view.connection?.id ?? 'new'}`}
          title={PROVIDER_LABEL[view.provider]}
          summary={view.connection?.account ?? view.connection?.serverUrl ?? (view.available ? 'Not connected' : 'Not set up')}
          status={view.connection ? (
            <Badge tone={view.connection.status === 'active' ? 'ok' : 'danger'}>
              {view.connection.status === 'active' ? 'connected' : 'needs reconnecting'}
            </Badge>
          ) : null}
          defaultOpen={Boolean(view.connection && view.connection.status !== 'active')}
        >

          {/* No application registered: say so, and offer nothing to press.
              Nextcloud is never "unavailable" this way — it has no application
              to register, so its own branch below handles both states. */}
          {!view.available && view.provider !== 'nextcloud' ? (
            <NotYet title="Not set up on this installation">
              An administrator has to register {PROVIDER_LABEL[view.provider]} application credentials before
              anyone can connect an account. Until then there is nothing to press here.
            </NotYet>
          ) : !view.connection && view.provider === 'nextcloud' ? (
            <NextcloudConnectForm busy={busy === 'nextcloud'} onConnect={connectNextcloud} />
          ) : !view.connection ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {PROVIDER_LABEL[view.provider]} asks once for Josi's supported permission bundle. Everything
                it grants starts on in Josi. You can turn any of it off here afterwards.
              </p>
              <Button onClick={() => void connect(view.provider)} disabled={busy === view.provider}>
                {busy === view.provider ? 'Starting…' : `Connect ${PROVIDER_LABEL[view.provider]}`}
              </Button>
            </>
          ) : (
            <>
              {view.connection.account ? (
                <p className="truncate text-sm text-muted-foreground">{view.connection.account}</p>
              ) : null}
              {view.connection.serverUrl ? (
                <p className="truncate text-sm text-muted-foreground">{view.connection.serverUrl}</p>
              ) : null}
              {view.connection.errorCategory ? (
                <p className="mt-1 text-sm text-destructive">
                  {ERROR_TEXT[view.connection.errorCategory] ?? 'Something went wrong with this connection.'}
                </p>
              ) : null}

              {view.connection.needsPermissionUpgrade ? (
                <div className="mt-3 rounded-md border border-border p-3">
                  <p className="mb-2 text-sm text-muted-foreground">
                    This account was connected before Josi requested its current permission bundle. Upgrade once;
                    afterwards every available capability is controlled locally with the On/Off buttons below.
                  </p>
                  <Button variant="secondary" onClick={() => void connect(view.provider, view.connection!.id)} disabled={busy === view.provider}>
                    {busy === view.provider ? 'Starting…' : `Upgrade permissions / Reconnect ${PROVIDER_LABEL[view.provider]}`}
                  </Button>
                </div>
              ) : null}

              <ul className="mt-3 space-y-3">
                {view.capabilities.map((capability) => (
                  <li key={capability.key} className="border-t border-border pt-3 first:border-0 first:pt-0">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 text-sm font-medium">{capability.label}</span>
                      <CapabilityControl
                        capability={capability}
                        busy={busy === capability.key}
                        onToggle={() => void toggle(view, capability)}
                      />
                    </div>
                    {/* What a write permission actually permits, before it can
                        be switched on. */}
                    {capability.kind === 'write' && capability.consequence ? (
                      <p className="mt-1 text-sm text-muted-foreground">{capability.consequence}</p>
                    ) : null}
                    {capability.adminNote ? (
                      <p className="mt-1 text-sm text-muted-foreground">{capability.adminNote}</p>
                    ) : null}
                  </li>
                ))}
              </ul>

              {/* Files. Real now — this replaces the "planned" placeholder.
                  Shown only under a live connection, because a folder is
                  mapped through a connection and read-only by scope. */}
              <CloudFolders
                provider={view.provider}
                connectionId={view.connection.id}
                capabilityOn={view.capabilities.some(
                  (c) => c.key === STORAGE_CAPABILITY_KEY[view.provider] && c.state === 'on',
                )}
              />

              <div className="mt-4">
                <Button variant="secondary" onClick={() => void disconnect(view)} disabled={busy === view.provider}>
                  Disconnect
                </Button>
                {OAUTH_PROVIDERS.includes(view.provider) ? (
                  <Button className="ml-2" variant="secondary" onClick={() => void connect(view.provider)} disabled={busy === view.provider}>
                    Add another {PROVIDER_LABEL[view.provider]} account
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </CollapsibleCard>
      ))}

      <DeveloperServices />

      <McpServers />

      <DocumentInventory />
    </div>
  );
}

interface DeveloperServiceRow {
  service: string;
  label: string;
  tokenLabel: string;
  tokenHelp: string;
  tokenUrl: string;
  capability: string;
  usernameLabel: string | null;
  emailLabel: string | null;
  baseUrlLabel: string | null;
  /** The whole form, one entry per box. Older servers do not send it. */
  fields?: DeveloperServiceField[];
  /** Whether an administrator permits ME to connect this. Separate from
   * whether I have. */
  allowed: boolean;
  note: string | null;
  connection: DeveloperAccount | null;
  /** Every account of this service I have connected. Older servers send only
   * `connection`, which is then the only one. */
  accounts?: DeveloperAccount[];
  maxAccounts?: number;
}

interface DeveloperAccount {
  /** Which account this is. Absent from an older server, where there is one. */
  account?: string;
  /** My own name for it. */
  name?: string | null;
  accountLabel: string | null;
  status: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  lastUsedAt: string | null;
}

const accountsOf = (row: DeveloperServiceRow): DeveloperAccount[] => row.accounts ?? (row.connection ? [row.connection] : []);

interface DeveloperServiceField {
  key: string;
  label: string;
  secret: boolean;
  multiline: boolean;
  help: string;
  /** May be left empty. */
  optional?: boolean;
}

/** The boxes to show for a service: what the server lists, or, for a server
 * from before it listed them, the same boxes worked out from its labels. */
function fieldsOf(row: DeveloperServiceRow): DeveloperServiceField[] {
  if (row.fields?.length) return row.fields;
  const plainField = (key: string, label: string): DeveloperServiceField => ({ key, label, secret: false, multiline: false, help: '' });
  return [
    ...(row.usernameLabel ? [plainField('username', row.usernameLabel)] : []),
    ...(row.emailLabel ? [plainField('email', row.emailLabel)] : []),
    ...(row.baseUrlLabel ? [plainField('baseUrl', row.baseUrlLabel)] : []),
    { key: 'token', label: row.tokenLabel, secret: true, multiline: false, help: '' },
  ];
}

/** My own GitHub, Netlify, Vercel and Supabase.
 *
 * These are mine: my token, my account, and I can disconnect at any time. An
 * administrator decides whether I am permitted to connect one at all, and their
 * reason is shown here rather than leaving a control that fails — but the
 * refusal is enforced by the server, not by this component hiding a button.
 */
function DeveloperServices() {
  const [rows, setRows] = useState<DeveloperServiceRow[] | null>(null);
  // What has been typed, by service and then by field key.
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved,setSaved]=useState('');
  // Which services have the "add another account" form open.
  const [adding, setAdding] = useState<Record<string, boolean>>({});
  useUnsavedChanges(Object.values(values).some((entered) => Object.values(entered).some(Boolean)));

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ services: DeveloperServiceRow[] }>('/connections/developer');
      setRows(res.services);
    } catch(e) {
      setError('Could not read saved provider state. Retry without discarding your edits.');throw e;
    }
  }, []);
  useEffect(() => { void load().catch(()=>undefined); }, [load]);

  async function run(service: string, failed: string, work: () => Promise<void>) {
    if(busy)return;
    setSaved('');
    setBusy(service);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
    } finally {
      setBusy('');
    }
  }

  /** Connect an account. The first one, or another: the server tells them
   * apart, and pasting an account that is already here replaces its key. */
  const connect = (service: string, label: string) => run(service, 'That could not be connected', async () => {
    const { accountName, ...fields } = values[service] ?? {};
    await api.post(`/connections/developer/${service}/accounts`, { ...fields, ...(accountName?.trim() ? { name: accountName.trim() } : {}) });
    await load();
    setValues((v) => ({ ...v, [service]: {} }));
    setAdding((v) => ({ ...v, [service]: false }));
    setSaved(`${label} account saved.`);
  });

  const check = (service: string, account?: string) => run(service, 'That check could not run', async () => {
    await api.post(account ? `/connections/developer/${service}/accounts/${account}/check` : `/connections/developer/${service}/check`, {});
    await load();
  });

  const disconnect = (service: string, account?: string) => run(service, 'That could not be disconnected', async () => {
    await api.del(account ? `/connections/developer/${service}/accounts/${account}` : `/connections/developer/${service}`);
    await load();
  });

  if (!rows?.length) return null;

  return (
    <>
      <h2 className="pt-2 text-lg font-semibold tracking-tight">Developer services</h2>
      <p className="text-sm text-muted-foreground">
        Your own accounts, connected with a token you create. Nobody else here can see the token,
        and disconnecting removes it.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {saved ? <p role="status">{saved}</p> : null}
      {rows.map((row) => (
        <Card key={row.service}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>{row.label}</CardTitle>
            {accountsOf(row).length ? (
              <Badge tone={accountsOf(row).some((a) => a.lastCheckOk === false) ? 'danger' : 'ok'}>
                {accountsOf(row).some((a) => a.lastCheckOk === false) ? 'needs attention'
                  : accountsOf(row).length > 1 ? `${accountsOf(row).length} accounts connected` : 'connected'}
              </Badge>
            ) : (
              <Badge tone="muted">{row.allowed ? 'not connected' : 'not available'}</Badge>
            )}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{row.capability}</p>

          {/* Not permitted: the administrator's reason, and no control. A
              disabled button that looks pressable is worse than none. */}
          {!row.allowed && !accountsOf(row).length ? (
            <NotYet title="An administrator has not made this available">
              {row.note ?? 'Ask your administrator if you need it.'}
            </NotYet>
          ) : null}

          {accountsOf(row).map((account, index) => (
            <div key={account.account ?? index} className="mt-2 space-y-2 border-t border-border pt-2 first:border-0">
              <p className="text-sm">
                <span className="font-medium">{account.name ?? account.accountLabel ?? 'Your account'}</span>
                {account.name && account.accountLabel ? <span className="text-muted-foreground"> · {account.accountLabel}</span> : null}
              </p>
              <p className="text-xs text-muted-foreground">
                {account.lastCheckAt ? `Checked ${new Date(account.lastCheckAt).toLocaleString()}` : 'Not checked yet'}
                {account.lastUsedAt ? ` · last used ${new Date(account.lastUsedAt).toLocaleString()}` : ''}
              </p>
              {account.lastCheckOk === false && account.lastError ? (
                <ErrorNote>{account.lastError}</ErrorNote>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="secondary" disabled={busy === row.service}
                        onClick={() => void check(row.service, account.account)}>
                  {busy === row.service ? 'Checking…' : 'Check it still works'}
                </Button>
                <Button type="button" variant="secondary" disabled={busy === row.service}
                        onClick={() => void disconnect(row.service, account.account)}>
                  Disconnect
                </Button>
              </div>
            </div>
          ))}

          {/* As many accounts as the person has: four Supabase accounts are
              four entries here, not one that keeps being replaced. */}
          {accountsOf(row).length && row.allowed && !adding[row.service]
            && accountsOf(row).length < (row.maxAccounts ?? 1) ? (
            <div className="mt-3">
              <Button type="button" variant="secondary" disabled={busy === row.service}
                      onClick={() => setAdding((v) => ({ ...v, [row.service]: true }))}>
                Add another {row.label} account
              </Button>
            </div>
          ) : null}

          {row.allowed && (!accountsOf(row).length || adding[row.service]) ? (
            <form
              className="mt-2 space-y-2"
              onSubmit={(e) => { e.preventDefault(); void connect(row.service, row.label); }}
            >
              {fieldsOf(row).map((field) => {
                const id = `dev-${row.service}-${field.key}`;
                const value = values[row.service]?.[field.key] ?? '';
                const set = (next: string) => setValues((v) => ({ ...v, [row.service]: { ...v[row.service], [field.key]: next } }));
                return (
                  <div key={field.key} className="space-y-1">
                    <label className="block text-sm" htmlFor={id}>{field.label}</label>
                    {field.multiline ? (
                      <textarea
                        id={id}
                        rows={6}
                        className="block w-full min-w-0 rounded-xl border border-border bg-input px-3.5 py-2 font-mono text-base placeholder:text-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm"
                        data-1p-ignore
                        data-lpignore="true"
                        data-form-type="other"
                        autoComplete="off"
                        autoCapitalize="none"
                        autoCorrect="off"
                        spellCheck={false}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                      />
                    ) : (
                      <Input
                        id={id}
                        type={field.secret ? 'password' : field.key === 'email' ? 'email' : field.key === 'baseUrl' ? 'url' : 'text'}
                        autoComplete={field.secret ? 'off' : field.key === 'username' ? 'username' : field.key === 'email' ? 'email' : 'off'}
                        autoCapitalize="none"
                        placeholder={field.key === 'baseUrl' ? 'https://your-site.atlassian.net' : undefined}
                        value={value}
                        onChange={(e) => set(e.target.value)}
                      />
                    )}
                    {field.help && field.help !== row.tokenHelp ? <p className="text-xs text-muted-foreground">{field.help}</p> : null}
                  </div>
                );
              })}
              <div className="space-y-1">
                <label className="block text-sm" htmlFor={`dev-${row.service}-accountName`}>Name for this account (optional)</label>
                <Input
                  id={`dev-${row.service}-accountName`}
                  type="text"
                  autoComplete="off"
                  maxLength={60}
                  placeholder="For example: Work, or a client's name"
                  value={values[row.service]?.accountName ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [row.service]: { ...v[row.service], accountName: e.target.value } }))}
                />
                <p className="text-xs text-muted-foreground">Your own name for it, so you and Josi can tell your accounts apart.</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {row.tokenHelp}{' '}
                <a className="underline" href={row.tokenUrl} target="_blank" rel="noreferrer noopener">
                  Open {row.label}
                </a>
              </p>
              <Button type="submit" disabled={busy === row.service || fieldsOf(row).some((field) => !field.optional && !(values[row.service]?.[field.key] ?? '').trim())}>
                {busy === row.service ? 'Connecting…' : accountsOf(row).length ? 'Add account' : 'Connect'}
              </Button>
              {adding[row.service] ? (
                <Button type="button" variant="secondary" disabled={busy === row.service}
                        onClick={() => { setAdding((v) => ({ ...v, [row.service]: false })); setValues((v) => ({ ...v, [row.service]: {} })); }}>
                  Cancel
                </Button>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Josi checks this with {row.label} before saving it, so a key or token that does not
                work is never stored as though it did.
              </p>
            </form>
          ) : null}
        </Card>
      ))}
    </>
  );
}

function DocumentInventory() {
  const [documents, setDocuments] = useState<Array<{ id: string; filename: string; state: string; skipReason: string | null; folder: string }>>([]);
  useEffect(() => { void api.get<{ documents: typeof documents }>('/storage/documents?limit=100').then((r) => setDocuments(r.documents)).catch(() => undefined); }, []);
  if (!documents.length) return null;
  return <Card><CardTitle>Files Josi can see</CardTitle><ul className="max-h-80 space-y-2 overflow-y-auto">
    {documents.map((document) => <li key={document.id} className="flex min-w-0 items-start justify-between gap-3 border-t border-border pt-2 first:border-0">
      <div className="min-w-0"><p className="truncate text-sm font-medium">{document.filename}</p><p className="truncate text-xs text-muted-foreground">{document.folder}</p>
      {document.skipReason ? <p className="text-xs text-destructive">Skipped: {document.skipReason.replace(/_/g, ' ')}</p> : null}</div>
      <Badge tone={document.state === 'indexed' ? 'ok' : 'muted'}>{plain('document_state', document.state)}</Badge>
    </li>)}
  </ul></Card>;
}

/** The server address, username and app password Nextcloud's own
 * integration pattern asks for — generated in the person's OWN Nextcloud
 * account under Settings → Security → Devices & sessions, not something Josi
 * ever asks a Nextcloud server for on their behalf. Verified against the
 * server by the API route before it is stored; a wrong password shows up
 * here as a plain refusal, not a silently-broken connection discovered later. */
function NextcloudConnectForm({
  busy, onConnect,
}: {
  busy: boolean;
  onConnect: (args: { serverUrl: string; username: string; appPassword: string }) => Promise<void>;
}) {
  const [serverUrl, setServerUrl] = useState('');
  const [username, setUsername] = useState('');
  const [appPassword, setAppPassword] = useState('');

  useUnsavedChanges(!!(serverUrl || username || appPassword));
  const canSubmit = serverUrl.trim() && username.trim() && appPassword.trim() && !busy;

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit) void onConnect({ serverUrl: serverUrl.trim(), username: username.trim(), appPassword });
      }}
    >
      <p className="text-sm text-muted-foreground">
        Connecting starts read-only. In your Nextcloud account, go to Settings → Security → Devices &amp;
        sessions and create a new app password for Josi — do not use your regular Nextcloud password here.
      </p>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Server address</span>
        <input
          type="text"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          placeholder="cloud.example.com"
          value={serverUrl}
          onChange={(e) => setServerUrl(e.target.value)}
          autoComplete="url"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">Username</span>
        <input
          type="text"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
        />
      </label>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">App password</span>
        <input
          type="password"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
          autoComplete="new-password"
        />
      </label>
      <Button type="submit" disabled={!canSubmit}>
        {busy ? 'Connecting…' : 'Connect Nextcloud'}
      </Button>
    </form>
  );
}

function CapabilityControl({
  capability, busy, onToggle,
}: { capability: Capability; busy: boolean; onToggle: () => void }) {
  // An administrator has switched this off installation-wide. Nothing to press:
  // a disabled control would imply the person could change it.
  if (capability.state === 'blocked_by_admin') {
    return <Badge>switched off by an administrator</Badge>;
  }
  if (capability.needsConsent) {
    return <Badge>available after account permission upgrade</Badge>;
  }
  return (
    <Button
      variant={capability.state === 'on' ? 'primary' : 'secondary'}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={capability.state === 'on'}
    >
      {capability.state === 'on' ? 'On' : 'Off'}
    </Button>
  );
}

function handshakeError(reason: string): string {
  switch (reason) {
    case 'declined':
      return 'You cancelled at the provider, so nothing was connected.';
    case 'consumed':
    case 'unknown':
    case 'expired':
      return 'That sign-in link had already been used or had expired. Start again.';
    case 'session_mismatch':
      return 'That sign-in was started in a different browser session. Start again here.';
    case 'wrong_provider':
      return 'That sign-in did not match the provider it was started for.';
    case 'revoked':
      return 'The provider refused the connection. Check the application credentials with your administrator.';
    default:
      return 'The connection could not be completed. Please try again.';
  }
}
