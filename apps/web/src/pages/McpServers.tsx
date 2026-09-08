// External MCP servers: somebody's own remote tool servers.
//
// One page, because "where do I connect my notes server?" should have one
// answer. It is deliberately NOT the Connections page and NOT the Developer
// services page: those hold an OAuth grant and a pasted personal access token,
// and both give the assistant nothing on their own. This page is the only one
// where a person hands the assistant tools somebody else wrote.
//
// So the page has one job above every other: MAKE IT OBVIOUS WHOSE WORDS THESE
// ARE. The name, the description and the inputs of every tool below were
// written by the remote server, not by Josi and not by anybody on this
// installation. Nothing here presents them as Josi's account of what a tool
// does, and the server's own "this only reads" annotation is shown as a claim
// with a label saying so.
//
// What the page must never do:
//
//   * Show a tool as switched on when nobody switched it on. Everything arrives
//     waiting for a decision, and the decision carries the exact text that was
//     on the screen so a server cannot change a tool between the reading and
//     the pressing.
//   * Show a credential, or anything derived from one. A connected server shows
//     a fixed mask.
//   * Let a server look connected because a form was filled in. Until Connect
//     succeeds there is no protocol version, no server name and no tool list.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface McpTool {
  id: string;
  serverId: string;
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  serverClaimsReadOnly: boolean | null;
  toolState: string;
  approvalMode: string;
  available: boolean;
  digest: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

interface McpServer {
  id: string;
  name: string;
  slug: string;
  endpointUrl: string;
  host: string;
  authKind: string;
  authHeader: string | null;
  hasCredential: boolean;
  credentialMask: string | null;
  enabled: boolean;
  serverStatus: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastErrorCategory: string | null;
  protocolVersion: string | null;
  serverLabel: string | null;
  lastDiscoveryAt: string | null;
  tools: McpTool[];
}

interface Ceiling {
  allowed: boolean;
  note: string | null;
  allowedHosts: string[];
}

interface Discovery {
  offered: number;
  added: number;
  changedAfterApproval: string[];
  noLongerOffered: string[];
}

const BLANK = { name: '', endpointUrl: '', slug: '', authKind: 'none', authHeader: '', secret: '' };

export function McpServers() {
  const [servers, setServers] = useState<McpServer[] | null>(null);
  const [ceiling, setCeiling] = useState<Ceiling>({ allowed: true, note: null, allowedHosts: [] });
  const [limit, setLimit] = useState(10);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ ...BLANK });
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ servers: McpServer[]; limit: number; policy: Ceiling }>('/mcp-servers');
      setServers(res.servers);
      setCeiling(res.policy);
      setLimit(res.limit);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load your MCP servers');
      setServers([]);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function run(key: string, fn: () => Promise<string | void>) {
    setBusy(key);
    setError('');
    setNotice('');
    try {
      const said = await fn();
      if (said) setNotice(said);
      await load();
    } catch (err) {
      // The server writes its errors for people. Passing one through beats
      // inventing a friendlier sentence that says less.
      setError(err instanceof ApiError ? err.message : 'That did not work');
    } finally {
      setBusy('');
    }
  }

  const body = () => ({
    name: form.name,
    endpointUrl: form.endpointUrl,
    ...(form.slug.trim() ? { slug: form.slug.trim() } : {}),
    authKind: form.authKind,
    ...(form.authKind === 'api_key' ? { authHeader: form.authHeader } : {}),
    ...(form.authKind === 'none' ? {} : { secret: form.secret }),
  });

  const add = () => run('add', async () => {
    await api.post('/mcp-servers', body());
    setAdding(false);
    setForm({ ...BLANK });
    return 'Saved, switched off and not yet contacted. Press Connect to check it.';
  });

  const save = (server: McpServer) => run(`edit-${server.id}`, async () => {
    await api.patch(`/mcp-servers/${server.id}`, body());
    setEditing(null);
    setForm({ ...BLANK });
    return 'Saved. Changing where or how Josi connects switches the server off until you connect again.';
  });

  const connect = (server: McpServer) => run(`connect-${server.id}`, async () => {
    const res = await api.post<{ discovery: Discovery; note?: string }>(`/mcp-servers/${server.id}/connect`);
    const d = res.discovery;
    return [
      res.note ?? `${server.name} answered. It offers ${d.offered} tool(s); ${d.added} are new and waiting for you.`,
      d.changedAfterApproval.length
        ? `${d.changedAfterApproval.length} tool(s) you had switched on were changed by that server, so `
          + `Josi switched them off: ${d.changedAfterApproval.join(', ')}. Read them again.`
        : '',
      d.noLongerOffered.length
        ? `${d.noLongerOffered.length} tool(s) are no longer offered: ${d.noLongerOffered.join(', ')}.`
        : '',
    ].filter(Boolean).join(' ');
  });

  if (servers === null) {
    return <div className="mx-auto w-full max-w-3xl p-4 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">MCP servers</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p role="status" className="text-sm text-emerald-300">{notice}</p> : null}

      <Card>
        <CardTitle>What this is</CardTitle>
        <p className="text-sm text-muted-foreground">
          An MCP server is a service that offers tools an assistant can use — your notes, your issue
          tracker, your own software. Connect one here and Josi will ask it what it offers. Nothing
          it offers is switched on until you read it and switch it on yourself, one tool at a time.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          The name, description and inputs of every tool below were written by that external server.
          Josi cannot see what a tool actually does — only what the server says about it. Treat the
          descriptions as claims.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          These servers are yours. Nobody else here can see or use them. An administrator can see
          that a server exists, which address it reaches and whether it is working, and can cut it
          off — they cannot read your credential or see which tools you switched on.
        </p>
      </Card>

      {!ceiling.allowed ? (
        <Card>
          <CardTitle>Switched off for this installation</CardTitle>
          <p className="text-sm text-muted-foreground">
            {ceiling.note
              ? `An administrator has switched MCP servers off: ${ceiling.note}`
              : 'An administrator has switched MCP servers off for this installation.'}
            {' '}
            You can still remove anything you already connected.
          </p>
        </Card>
      ) : null}

      {ceiling.allowed && ceiling.allowedHosts.length ? (
        <Card>
          <CardTitle>Allowed addresses</CardTitle>
          <p className="text-sm text-muted-foreground">
            An administrator has limited MCP servers to: {ceiling.allowedHosts.join(', ')}. Anything
            else is refused.
          </p>
        </Card>
      ) : null}

      {servers.length === 0 && !adding ? (
        <Empty title="No MCP servers connected">
          When you connect one, Josi will ask it what tools it offers and list them here for you to
          review.
        </Empty>
      ) : null}

      {servers.map((server) => (
        <Card key={server.id}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <CardTitle>{server.name}</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={server.serverStatus === 'active' ? 'ok' : server.serverStatus === 'unverified' ? 'muted' : 'danger'}>
                {plain('mcp_server_status', server.serverStatus)}
              </Badge>
              <Badge tone={server.enabled ? 'primary' : 'muted'}>
                {server.enabled ? 'Available to Josi' : 'Not available to Josi'}
              </Badge>
            </div>
          </div>

          <p className="break-all text-xs text-muted-foreground">
            Requests go only to {server.host}
            {server.serverLabel ? ` — it calls itself "${server.serverLabel}"` : ''}
            {server.protocolVersion ? ` (MCP ${server.protocolVersion})` : ''}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Short name for the assistant: {server.slug} · Credential:{' '}
            {server.hasCredential ? server.credentialMask : 'none'}
          </p>
          {server.lastErrorCategory ? (
            <p className="mt-1 text-xs text-destructive">
              {plainDetail('connector_error', server.lastErrorCategory)
                ?? plain('connector_error', server.lastErrorCategory)}
            </p>
          ) : null}
          {server.serverStatus === 'unverified' ? (
            <p className="mt-1 text-xs text-muted-foreground">
              {plainDetail('mcp_server_status', 'unverified')}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              disabled={busy === `connect-${server.id}` || !ceiling.allowed}
              onClick={() => void connect(server)}
            >
              {busy === `connect-${server.id}` ? 'Connecting…' : 'Connect and list tools'}
            </Button>
            <Button
              variant="secondary"
              disabled={busy === `toggle-${server.id}`}
              onClick={() => void run(`toggle-${server.id}`, async () => {
                await api.post(`/mcp-servers/${server.id}/${server.enabled ? 'disable' : 'enable'}`);
              })}
            >
              {server.enabled ? 'Make unavailable' : 'Make available to Josi'}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(editing === server.id ? null : server.id);
                setForm({
                  name: server.name,
                  endpointUrl: server.endpointUrl,
                  slug: server.slug,
                  authKind: server.authKind,
                  authHeader: server.authHeader ?? '',
                  secret: '',
                });
              }}
            >
              {editing === server.id ? 'Stop editing' : 'Edit'}
            </Button>
            <Button
              variant="danger"
              disabled={busy === `remove-${server.id}`}
              onClick={() => void run(`remove-${server.id}`, async () => {
                const res = await api.del<{ note?: string }>(`/mcp-servers/${server.id}`);
                return res?.note;
              })}
            >
              Remove
            </Button>
          </div>

          {editing === server.id ? (
            <div className="mt-3 border-t border-border pt-3">
              <ServerFields form={form} setForm={setForm} editing />
              <Button disabled={busy === `edit-${server.id}`} onClick={() => void save(server)}>
                Save changes
              </Button>
            </div>
          ) : null}

          <div className="mt-4 border-t border-border pt-3">
            <h3 className="text-sm font-semibold">Tools this server offers</h3>
            {server.tools.length === 0 ? (
              <p className="mt-1 text-sm text-muted-foreground">
                Nothing yet. Press Connect and Josi will ask the server what it offers.
              </p>
            ) : (
              <ul className="mt-2 space-y-3">
                {server.tools.map((tool) => (
                  <ToolRow
                    key={tool.id}
                    tool={tool}
                    busy={busy}
                    run={run}
                  />
                ))}
              </ul>
            )}
          </div>
        </Card>
      ))}

      {adding ? (
        <Card>
          <CardTitle>Connect an MCP server</CardTitle>
          <p className="mb-3 text-sm text-muted-foreground">
            Give the server&apos;s MCP endpoint address. It must start with https:// and be reachable
            on the public internet — Josi will not contact an address on this machine or on your
            local network, and will not follow a redirect away from the address you give.
          </p>
          <ServerFields form={form} setForm={setForm} />
          <div className="flex flex-wrap gap-2">
            <Button disabled={busy === 'add'} onClick={() => void add()}>Save</Button>
            <Button variant="ghost" onClick={() => { setAdding(false); setForm({ ...BLANK }); }}>
              Cancel
            </Button>
          </div>
        </Card>
      ) : (
        <Button
          disabled={!ceiling.allowed || servers.length >= limit}
          onClick={() => { setAdding(true); setForm({ ...BLANK }); }}
        >
          Connect a server
        </Button>
      )}
      {servers.length >= limit ? (
        <p className="text-sm text-muted-foreground">
          You have reached the limit of {limit} servers. Remove one you no longer use to add another.
        </p>
      ) : null}
    </div>
  );
}

/** One tool, with the decision it is waiting for.
 *
 * The server's words are labelled as the server's words in three places, and
 * the approval carries `tool.digest` — the exact text on the screen — so a
 * server that changes the description between rendering and pressing is refused
 * rather than approved.
 */
function ToolRow({
  tool, busy, run,
}: {
  tool: McpTool;
  busy: string;
  run: (key: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  const approve = (approvalMode: 'ask' | 'auto') => run(`tool-${tool.id}`, async () => {
    await api.post(`/mcp-servers/tools/${tool.id}/approve`, { approvalMode, digest: tool.digest });
  });

  return (
    <li className="border-t border-border pt-3 first:border-0 first:pt-0">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <code className="min-w-0 break-all text-sm font-medium">{tool.name}</code>
        <div className="flex flex-wrap items-center gap-2">
          {!tool.available ? <Badge tone="muted">No longer offered</Badge> : null}
          <Badge tone={tool.toolState === 'approved' ? 'ok' : tool.toolState === 'changed' ? 'danger' : 'muted'}>
            {plain('mcp_tool_state', tool.toolState)}
          </Badge>
          {tool.toolState === 'approved' ? (
            <Badge tone={tool.approvalMode === 'auto' ? 'primary' : 'muted'}>
              {plain('mcp_approval_mode', tool.approvalMode)}
            </Badge>
          ) : null}
        </div>
      </div>

      <p className="mt-1 text-sm">
        <span className="text-muted-foreground">The server describes it as: </span>
        {tool.description || tool.title || 'nothing at all.'}
      </p>
      {tool.serverClaimsReadOnly !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">
          That server also claims this tool {tool.serverClaimsReadOnly ? 'only reads' : 'changes something'}.
          That is the server&apos;s own word for it and Josi does not act on it — you decide below.
        </p>
      ) : null}
      {plainDetail('mcp_tool_state', tool.toolState) ? (
        <p className="mt-1 text-xs text-muted-foreground">{plainDetail('mcp_tool_state', tool.toolState)}</p>
      ) : null}

      <details className="mt-1">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          Show the inputs this tool declares
        </summary>
        <pre className="mt-1 max-h-56 overflow-auto rounded bg-secondary p-2 text-xs">
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      </details>

      {tool.available ? (
        <div className="mt-2 flex flex-wrap gap-2">
          {tool.toolState === 'approved' ? (
            <Button
              variant="secondary"
              disabled={busy === `tool-${tool.id}`}
              onClick={() => void run(`tool-${tool.id}`, async () => {
                await api.post(`/mcp-servers/tools/${tool.id}/revoke`);
              })}
            >
              Switch off
            </Button>
          ) : (
            <>
              <Button disabled={busy === `tool-${tool.id}`} onClick={() => void approve('ask')}>
                Switch on — ask me every time
              </Button>
              <Button
                variant="secondary"
                disabled={busy === `tool-${tool.id}`}
                onClick={() => void approve('auto')}
              >
                Switch on — run without asking
              </Button>
            </>
          )}
        </div>
      ) : null}
      {tool.available && tool.toolState !== 'approved' ? (
        <p className="mt-1 text-xs text-muted-foreground">
          {plainDetail('mcp_approval_mode', 'ask')}
        </p>
      ) : null}
    </li>
  );
}

function ServerFields({
  form, setForm, editing = false,
}: {
  form: typeof BLANK;
  setForm: (next: typeof BLANK) => void;
  editing?: boolean;
}) {
  const set = (key: keyof typeof BLANK) => (value: string) => setForm({ ...form, [key]: value });
  return (
    <div className="mb-3 space-y-2">
      <label className="block text-xs text-muted-foreground" htmlFor="mcp-name">A name you will recognise</label>
      <Input
        id="mcp-name"
        value={form.name}
        placeholder="My notes"
        autoComplete="off"
        onChange={(e) => set('name')(e.target.value)}
      />

      <label className="block text-xs text-muted-foreground" htmlFor="mcp-url">The server&apos;s MCP endpoint</label>
      <Input
        id="mcp-url"
        value={form.endpointUrl}
        placeholder="https://mcp.example.com/mcp"
        autoComplete="off"
        onChange={(e) => set('endpointUrl')(e.target.value)}
      />

      <label className="block text-xs text-muted-foreground" htmlFor="mcp-slug">
        Short name the assistant uses (optional — made from the name if you leave it blank)
      </label>
      <Input
        id="mcp-slug"
        value={form.slug}
        placeholder="my_notes"
        autoComplete="off"
        disabled={editing}
        onChange={(e) => set('slug')(e.target.value)}
      />

      <label className="block text-xs text-muted-foreground" htmlFor="mcp-auth">How it authenticates</label>
      <select
        id="mcp-auth"
        className="min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm"
        value={form.authKind}
        onChange={(e) => set('authKind')(e.target.value)}
      >
        <option value="none">No credential</option>
        <option value="bearer">A bearer token</option>
        <option value="api_key">An API key in a header</option>
      </select>

      {form.authKind === 'api_key' ? (
        <>
          <label className="block text-xs text-muted-foreground" htmlFor="mcp-header">Which header carries it</label>
          <Input
            id="mcp-header"
            value={form.authHeader}
            placeholder="X-API-Key"
            autoComplete="off"
            onChange={(e) => set('authHeader')(e.target.value)}
          />
        </>
      ) : null}

      {form.authKind !== 'none' ? (
        <>
          <label className="block text-xs text-muted-foreground" htmlFor="mcp-secret">
            {editing ? 'Replace the credential (leave blank to keep the one stored)' : 'The credential'}
          </label>
          <Input
            id="mcp-secret"
            type="password"
            value={form.secret}
            // Name and autocomplete are deliberately not a credential's: a
            // browser password manager offering to fill somebody's Josi login
            // into a third party's token field is the bug 0eb8c2a fixed
            // elsewhere.
            name="mcp-server-value"
            autoComplete="off"
            onChange={(e) => set('secret')(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            It is encrypted before it is stored and is never shown again. Josi sends it only to{' '}
            {form.endpointUrl ? 'the address above' : 'the server you name above'}, in a header, over https.
          </p>
        </>
      ) : null}
    </div>
  );
}
