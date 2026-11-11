// Custom MCP servers: a person's own outside tool servers.
//
// These are mine: my server, my sign-in, and I can remove one at any time. The
// owner of this Josi decides whether I may add any at all, and their reason is
// shown here — but the refusal is enforced by the server, not by this
// component hiding a button.
//
// Two things this page must say plainly, because they are the whole safety
// argument of the feature:
//
//   * which tools Josi runs on its own (the ones the server marks read-only)
//     and which it asks me about first (everything else);
//   * that what a server says — names, descriptions, answers — is the
//     server's, not Josi's.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, CollapsibleCard, ErrorNote, Input, NotYet } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';
import { useUnsavedChanges } from '@/lib/useUnsavedChanges';

type Auth = 'none' | 'bearer' | 'header' | 'oauth';

interface McpTool {
  name: string;
  description: string;
  readOnly: boolean;
  asksFirst: boolean;
  enabled: boolean;
}

interface McpConnection {
  id: string;
  name: string;
  slug: string;
  url: string;
  host: string;
  auth: Auth;
  headerName: string | null;
  credentialSet: boolean;
  oauth: { signInServer: string | null; signedIn: boolean; expiresAt: string | null } | null;
  status: string;
  enabled: boolean;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
  serverName: string | null;
  toolsFetchedAt: string | null;
  toolsLeftOut: number;
  tools: McpTool[];
}

interface McpView {
  allowed: boolean;
  note: string | null;
  maxConnections: number;
  redirectUri: string;
  connections: McpConnection[];
}

const AUTH_CHOICES: Array<{ value: Auth; help: string }> = [
  { value: 'none', help: 'The server is open to anyone who has its address.' },
  { value: 'bearer', help: 'The server gave you a token (sometimes called an API key or access token).' },
  { value: 'header', help: 'The server wants a value in a header with a particular name, such as X-API-Key.' },
  { value: 'oauth', help: 'The server sends you to a sign-in page. Josi opens it for you after you add the server.' },
];

const EMPTY_FORM = { name: '', url: '', auth: 'none' as Auth, token: '', headerName: '', headerValue: '', clientId: '', clientSecret: '' };

function signInProblem(reason: string): string {
  switch (reason) {
    case 'declined': return 'You cancelled at the sign-in page, so nothing was connected.';
    case 'expired': case 'consumed': case 'unknown': return 'That sign-in link had already been used or had expired. Start again.';
    case 'session': return 'You were not signed in to Josi in that browser. Sign in here and start again.';
    case 'wrong_person': return 'That sign-in was started by a different account.';
    default: return 'The sign-in could not be completed. Please try again.';
  }
}

export function McpServers({ query = '', showAll = false }: { query?: string; showAll?: boolean }) {
  const [view, setView] = useState<McpView | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [adding, setAdding] = useState(false);
  const [needsClientId, setNeedsClientId] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useUnsavedChanges(adding && !!(form.name || form.url || form.token || form.headerValue || form.clientSecret));

  const load = useCallback(async () => {
    setView(await api.get<McpView>('/connections/mcp'));
  }, []);

  useEffect(() => {
    void load().catch(() => undefined);
    // The sign-in page comes back here with how it went.
    const params = new URLSearchParams(window.location.search);
    if (params.get('mcp') === 'connected') setNotice('Signed in. The server\'s tools are listed below.');
    const reason = params.get('mcp_error');
    if (reason) setError(signInProblem(reason));
  }, [load]);

  async function run(id: string, failed: string, work: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : failed);
      await load().catch(() => undefined);
    } finally {
      setBusy('');
    }
  }

  /** Opens the server's own sign-in page. The address comes from the server
   * Josi asked; this page never builds one. */
  const signIn = (connection: McpConnection) => run(connection.id, 'The sign-in could not be started', async () => {
    const res = await api.post<{ authorizationUrl: string }>(`/connections/mcp/${connection.id}/oauth/start`, {});
    window.location.assign(res.authorizationUrl);
  });

  const add = () => run('add', 'That server could not be added', async () => {
    try {
      const res = await api.post<{ signInNeeded: boolean; connection: McpConnection }>('/connections/mcp', {
        name: form.name.trim(), url: form.url.trim(), auth: form.auth,
        ...(form.auth === 'bearer' ? { token: form.token.trim() } : {}),
        ...(form.auth === 'header' ? { headerName: form.headerName.trim(), headerValue: form.headerValue.trim() } : {}),
        ...(form.auth === 'oauth' && form.clientId.trim() ? { clientId: form.clientId.trim(), clientSecret: form.clientSecret.trim() || undefined } : {}),
      });
      setForm(EMPTY_FORM);
      setAdding(false);
      setNeedsClientId(false);
      await load();
      if (res.signInNeeded) {
        setNotice(`${res.connection.name} was added. Sign in to it to finish.`);
      } else {
        setNotice(`${res.connection.name} was added and offers ${res.connection.tools.length} tool${res.connection.tools.length === 1 ? '' : 's'}.`);
      }
    } catch (err) {
      // The one refusal this form reacts to: the server will not register
      // Josi by itself, so the person has to paste a client id.
      if (err instanceof ApiError && (err.body as { code?: string } | null)?.code === 'client_id_required') setNeedsClientId(true);
      throw err;
    }
  });

  const check = (connection: McpConnection) => run(connection.id, 'That check could not run', async () => {
    const res = await api.post<{ ok: boolean; detail: string }>(`/connections/mcp/${connection.id}/check`, {});
    await load();
    if (res.ok) setNotice(res.detail); else setError(res.detail);
  });

  const setEnabled = (connection: McpConnection, enabled: boolean) => run(connection.id, 'That could not be changed', async () => {
    await api.patch(`/connections/mcp/${connection.id}`, { enabled });
    await load();
  });

  const setToolEnabled = (connection: McpConnection, tool: McpTool, enabled: boolean) => run(connection.id, 'That could not be changed', async () => {
    const off = new Set(connection.tools.filter((t) => !t.enabled).map((t) => t.name));
    if (enabled) off.delete(tool.name); else off.add(tool.name);
    await api.patch(`/connections/mcp/${connection.id}`, { disabledTools: [...off] });
    await load();
  });

  const remove = (connection: McpConnection) => run(connection.id, 'That could not be removed', async () => {
    await api.del(`/connections/mcp/${connection.id}`);
    await load();
    setNotice(`${connection.name} was removed, along with its sign-in.`);
  });

  if (!view) return null;
  // The Connections page's search box. With something typed, this section
  // shows when "mcp" or one of the servers matches; otherwise when there is a
  // server, or everything was asked for. A sign-in in progress always shows.
  const filtering = query.length > 0;
  const sectionMatches = 'custom mcp servers'.includes(query);
  const connections = filtering && !sectionMatches
    ? view.connections.filter((c) => c.name.toLowerCase().includes(query) || c.host.toLowerCase().includes(query))
    : view.connections;
  const showSection = adding || Boolean(notice) || Boolean(error)
    || (filtering ? sectionMatches || connections.length > 0 : view.connections.length > 0 || showAll);
  if (!showSection) return null;
  const canSubmit = form.name.trim() && form.url.trim()
    && (form.auth !== 'bearer' || form.token.trim())
    && (form.auth !== 'header' || (form.headerName.trim() && form.headerValue.trim()));

  return (
    <>
      <h2 className="pt-2 text-lg font-semibold tracking-tight">Custom MCP servers</h2>
      <p className="text-sm text-muted-foreground">
        An MCP server is a web address that gives Josi extra tools, such as searching a notes app or filing a ticket.
        The ones you add here are yours alone: nobody else on this Josi can use them or see your sign-in.
      </p>
      {adding || !view.connections.length ? (
        <p className="text-sm text-muted-foreground">
          Josi uses a tool on its own only when the server marks it as read-only. Every other tool asks you first, each
          time, on your Approvals page. Only add servers you trust: what a server tells Josi is the server&apos;s, not Josi&apos;s.
        </p>
      ) : null}
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p role="status" className="text-sm text-success">{notice}</p> : null}

      {!view.allowed && !view.connections.length ? (
        <Card>
          <NotYet title="The owner of this Josi has not made this available">
            {view.note ?? 'Ask the owner if you need it.'}
          </NotYet>
        </Card>
      ) : null}

      {connections.map((connection) => {
        const working = connection.enabled && connection.status === 'active';
        const runsFreely = connection.tools.filter((t) => t.enabled && !t.asksFirst);
        const asks = connection.tools.filter((t) => t.enabled && t.asksFirst);
        return (
          <CollapsibleCard
            key={connection.id}
            title={connection.name}
            summary={`${connection.host} · ${connection.tools.length} tool${connection.tools.length === 1 ? '' : 's'}`}
            status={(
              <Badge tone={!connection.enabled ? 'muted' : working ? 'ok' : 'danger'}>
                {connection.enabled ? plain('mcp_status', connection.status) : 'Switched off'}
              </Badge>
            )}
            defaultOpen={connection.enabled && !working}
          >
            <p className="break-all text-sm text-muted-foreground">{connection.host} · {plain('mcp_auth_kind', connection.auth)}</p>
            <p className="text-xs text-muted-foreground">
              {connection.lastCheckAt ? `Checked ${new Date(connection.lastCheckAt).toLocaleString()}` : 'Not checked yet'}
              {' · '}Josi calls it &quot;{connection.slug}&quot;
            </p>
            {connection.enabled && connection.status !== 'active' ? (
              <ErrorNote>{connection.lastError ?? plainDetail('mcp_status', connection.status) ?? 'This server needs attention.'}</ErrorNote>
            ) : null}
            {!view.allowed ? (
              <p className="mt-2 text-sm text-muted-foreground">
                The owner of this Josi no longer allows MCP servers for your account, so Josi is not using this one. You can still remove it.
              </p>
            ) : null}

            {connection.tools.length ? (
              <div className="mt-3 space-y-3">
                <ToolGroup
                  title="Josi uses these on its own"
                  hint="The server marks them as read-only."
                  tools={runsFreely} busy={busy === connection.id}
                  onToggle={(tool) => void setToolEnabled(connection, tool, false)}
                />
                <ToolGroup
                  title="Josi asks you first, every time"
                  hint="They may change, send or delete something."
                  tools={asks} busy={busy === connection.id}
                  onToggle={(tool) => void setToolEnabled(connection, tool, false)}
                />
                <ToolGroup
                  title="Switched off"
                  hint="Josi does not see these."
                  tools={connection.tools.filter((t) => !t.enabled)} busy={busy === connection.id} off
                  onToggle={(tool) => void setToolEnabled(connection, tool, true)}
                />
                {connection.tools.some((t) => t.enabled && t.readOnly && t.asksFirst) ? (
                  <p className="text-xs text-muted-foreground">
                    Some tools now say they are read-only but used to be able to change things. Josi keeps asking about
                    them until you press &quot;Check it still works&quot;, which accepts what the server says now.
                  </p>
                ) : null}
                {connection.toolsLeftOut ? (
                  <p className="text-xs text-muted-foreground">
                    {connection.toolsLeftOut} more {connection.toolsLeftOut === 1 ? 'tool was' : 'tools were'} left out: Josi keeps at most 100 per server and skips tools that are too large to describe.
                  </p>
                ) : null}
              </div>
            ) : connection.status === 'active' ? (
              <p className="mt-2 text-sm text-muted-foreground">This server answered but offers no tools.</p>
            ) : null}

            <div className="mt-3 flex flex-wrap gap-2">
              {connection.auth === 'oauth' && view.allowed ? (
                <Button type="button" variant={connection.status === 'needs_sign_in' ? 'primary' : 'secondary'}
                        disabled={busy === connection.id} onClick={() => void signIn(connection)}>
                  {connection.oauth?.signedIn ? 'Sign in again' : 'Sign in'}
                </Button>
              ) : null}
              {view.allowed && (connection.auth !== 'oauth' || connection.oauth?.signedIn) ? (
                <Button type="button" variant="secondary" disabled={busy === connection.id} onClick={() => void check(connection)}>
                  {busy === connection.id ? 'Checking…' : 'Check it still works'}
                </Button>
              ) : null}
              {connection.enabled ? (
                <Button type="button" variant="secondary" disabled={busy === connection.id} onClick={() => void setEnabled(connection, false)}>
                  Switch off
                </Button>
              ) : view.allowed ? (
                <Button type="button" variant="secondary" disabled={busy === connection.id} onClick={() => void setEnabled(connection, true)}>
                  Switch on
                </Button>
              ) : null}
              <Button type="button" variant="secondary" disabled={busy === connection.id} onClick={() => void remove(connection)}>
                Remove
              </Button>
            </div>
          </CollapsibleCard>
        );
      })}

      {view.allowed && !adding && view.connections.length < view.maxConnections ? (
        <div>
          <Button type="button" variant={view.connections.length ? 'secondary' : 'primary'} onClick={() => { setAdding(true); setError(''); setNotice(''); }}>
            Add an MCP server
          </Button>
        </div>
      ) : null}

      {view.allowed && adding ? (
        <Card>
          <CardTitle>Add an MCP server</CardTitle>
          <form className="mt-2 space-y-3" onSubmit={(e) => { e.preventDefault(); if (canSubmit) void add(); }}>
            <div className="space-y-1">
              <label className="block text-sm" htmlFor="mcp-name">Name</label>
              <Input id="mcp-name" value={form.name} maxLength={80} placeholder="For example: My notes"
                     onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="block text-sm" htmlFor="mcp-url">Address</label>
              <Input id="mcp-url" type="url" autoCapitalize="none" autoComplete="off" value={form.url} placeholder="https://example.com/mcp"
                     onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))} />
              <p className="text-xs text-muted-foreground">
                The server&apos;s web address, starting with https://. Josi connects to servers on the internet only; it cannot start a program on this computer.
              </p>
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm">How do you sign in to it?</legend>
              {AUTH_CHOICES.map((choice) => (
                <label key={choice.value} className="flex min-h-11 items-start gap-2 text-sm">
                  <input type="radio" name="mcp-auth" className="mt-1 h-4 w-4" checked={form.auth === choice.value}
                         onChange={() => { setForm((f) => ({ ...f, auth: choice.value })); setNeedsClientId(false); }} />
                  <span>
                    <span className="block">{plain('mcp_auth_kind', choice.value)}</span>
                    <span className="block text-xs text-muted-foreground">{choice.help}</span>
                  </span>
                </label>
              ))}
            </fieldset>

            {form.auth === 'bearer' ? (
              <div className="space-y-1">
                <label className="block text-sm" htmlFor="mcp-token">Token</label>
                <Input id="mcp-token" type="password" autoComplete="off" autoCapitalize="none" value={form.token}
                       onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))} />
              </div>
            ) : null}
            {form.auth === 'header' ? (
              <>
                <div className="space-y-1">
                  <label className="block text-sm" htmlFor="mcp-header-name">Header name</label>
                  <Input id="mcp-header-name" autoComplete="off" autoCapitalize="none" value={form.headerName} placeholder="X-API-Key"
                         onChange={(e) => setForm((f) => ({ ...f, headerName: e.target.value }))} />
                </div>
                <div className="space-y-1">
                  <label className="block text-sm" htmlFor="mcp-header-value">Value</label>
                  <Input id="mcp-header-value" type="password" autoComplete="off" autoCapitalize="none" value={form.headerValue}
                         onChange={(e) => setForm((f) => ({ ...f, headerValue: e.target.value }))} />
                </div>
              </>
            ) : null}
            {form.auth === 'oauth' ? (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  Josi asks the server where its sign-in page is and introduces itself there. Most servers need nothing more from you.
                </p>
                {needsClientId ? (
                  <NotYet title="This server needs you to register Josi with it first">
                    In the server&apos;s own settings, create an app (sometimes called an OAuth client) and give it this return address:
                    <span className="mt-1 block break-all font-mono text-xs">{view.redirectUri}</span>
                    Then paste the client id it gives you below.
                  </NotYet>
                ) : null}
                <details open={needsClientId}>
                  <summary className="cursor-pointer py-2 text-sm">I already have a client id for this server</summary>
                  <div className="space-y-2">
                    <div className="space-y-1">
                      <label className="block text-sm" htmlFor="mcp-client-id">Client id</label>
                      <Input id="mcp-client-id" autoComplete="off" autoCapitalize="none" value={form.clientId}
                             onChange={(e) => setForm((f) => ({ ...f, clientId: e.target.value }))} />
                    </div>
                    <div className="space-y-1">
                      <label className="block text-sm" htmlFor="mcp-client-secret">Client secret (only if the server gave you one)</label>
                      <Input id="mcp-client-secret" type="password" autoComplete="off" autoCapitalize="none" value={form.clientSecret}
                             onChange={(e) => setForm((f) => ({ ...f, clientSecret: e.target.value }))} />
                    </div>
                    <p className="break-all text-xs text-muted-foreground">Return address to give the server: {view.redirectUri}</p>
                  </div>
                </details>
              </div>
            ) : null}

            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={busy === 'add' || !canSubmit}>
                {busy === 'add' ? 'Connecting…' : form.auth === 'oauth' ? 'Add, then sign in' : 'Connect'}
              </Button>
              <Button type="button" variant="secondary" disabled={busy === 'add'}
                      onClick={() => { setAdding(false); setForm(EMPTY_FORM); setNeedsClientId(false); }}>
                Cancel
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Josi contacts the server and asks for its tools before saving it, so a server that does not answer is never saved as though it did.
              What you paste here is sealed in your Vault and is never shown again.
            </p>
          </form>
        </Card>
      ) : null}
    </>
  );
}

function ToolGroup({ title, hint, tools, busy, off = false, onToggle }: {
  title: string; hint: string; tools: McpTool[]; busy: boolean; off?: boolean; onToggle: (tool: McpTool) => void;
}) {
  if (!tools.length) return null;
  return (
    <div>
      <p className="text-sm font-medium">{title} <span className="font-normal text-muted-foreground">· {hint}</span></p>
      <ul className="mt-1 divide-y divide-border">
        {tools.map((tool) => (
          <li key={tool.name} className="flex items-start justify-between gap-3 py-2">
            <span className="min-w-0">
              <span className="block break-all text-sm">{tool.name}</span>
              {/* The server's own description of its tool, shown as such. */}
              {tool.description ? <span className="block break-words text-xs text-muted-foreground">The server says: {tool.description}</span> : null}
            </span>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => onToggle(tool)}>
              {off ? 'Switch on' : 'Switch off'}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
