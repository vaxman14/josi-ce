// Administration for external MCP servers.
//
// Two things, and it must not imply a third.
//
//   1. A deny-only ceiling. Switching MCP servers off stops anyone connecting
//      one and stops Josi contacting the ones that already exist — every route
//      that opens a sealed credential checks the ceiling, not only the one that
//      stores it. Switching it back on grants nothing: it returns the choice to
//      each person, who still has to connect their own server and approve each
//      tool. The address list narrows and never widens; empty means "no
//      restriction beyond the public-internet rule".
//   2. Health. Whose server it is, WHICH HOST it reaches, whether it works, and
//      how many tools they have switched on.
//
// The host is here and the tool names are not, and the line between them is
// deliberate. An outbound destination from the operator's own machine is a fact
// about this installation's network, and the address list above cannot be
// written by somebody who cannot see the candidates. Which tools a person
// switched on, what those tools are called and what they claim to do is a fact
// about that person's own account, and administering plumbing is not reading
// accounts. The owner's own page says plainly that an administrator can see the
// address, so nothing here is a surprise.
//
// The third thing, which does not exist here on purpose: connecting a server or
// approving a tool on somebody else's behalf. There is no route for it.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface Ceiling {
  allowed: boolean;
  note: string | null;
  allowedHosts: string[];
}

interface HealthRow {
  id: string;
  owner_user_id: string;
  username: string | null;
  host: string;
  enabled: boolean;
  status: string;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: string | null;
  approved_tools: number;
  created_at: string;
}

export function AdminMcpServers() {
  const [policy, setPolicy] = useState<Ceiling>({ allowed: true, note: null, allowedHosts: [] });
  const [servers, setServers] = useState<HealthRow[]>([]);
  const [hosts, setHosts] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ policy: Ceiling; servers: HealthRow[] }>('/admin/mcp-servers');
      setPolicy(res.policy);
      setServers(res.servers);
      setHosts(res.policy.allowedHosts.join(', '));
      setNote(res.policy.note ?? '');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load MCP servers');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function save(next: Partial<Ceiling>) {
    setBusy('policy');
    setError('');
    try {
      await api.put('/admin/mcp-servers/policy', {
        allowed: next.allowed ?? policy.allowed,
        note: note.trim() || null,
        allowedHosts: hosts.split(',').map((h) => h.trim()).filter(Boolean),
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that');
    } finally {
      setBusy('');
    }
  }

  async function cutOff(row: HealthRow) {
    setBusy(row.id);
    setError('');
    try {
      await api.del(`/admin/mcp-servers/connections/${row.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not remove that');
    } finally {
      setBusy('');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">MCP servers</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card>
        <CardTitle>What this installation permits</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          This can only take permissions away. Switching MCP servers off stops anyone connecting one
          and stops Josi contacting the ones that already exist; their owners can still remove them
          and take their credentials back. Switching it on does not switch anything on for anyone —
          each person still has to connect their own server and approve each tool by hand. Nothing
          here is preset.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={policy.allowed ? 'secondary' : 'danger'}
            disabled={busy === 'policy'}
            aria-pressed={!policy.allowed}
            onClick={() => void save({ allowed: !policy.allowed })}
          >
            {policy.allowed ? 'Allowed' : 'Switched off'}
          </Button>
        </div>

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="mcp-note">
          A reason, shown to anybody this refuses
        </label>
        <Input
          id="mcp-note"
          value={note}
          placeholder="Use the approved vendor list instead"
          onChange={(e) => setNote(e.target.value)}
        />

        <label className="mt-3 block text-xs text-muted-foreground" htmlFor="mcp-hosts">
          Addresses people may connect to, separated by commas. Leave blank for no restriction
          beyond the rule that a server must be on the public internet.
        </label>
        <Input
          id="mcp-hosts"
          value={hosts}
          placeholder="mcp.example.com, tools.vendor.test"
          onChange={(e) => setHosts(e.target.value)}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Hostnames only — not a full address, a path or a port. This list narrows what people may
          connect; it never grants anything.
        </p>
        <div className="mt-3">
          <Button disabled={busy === 'policy'} onClick={() => void save({})}>Save</Button>
        </div>
      </Card>

      <Card>
        <CardTitle>Connection health</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Whose server it is, where it goes and whether it works. Not the credential — that stays
          encrypted and is not readable from here — and not which tools they switched on or what
          those tools do.
        </p>
        {servers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has connected an MCP server yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[30rem] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Person</th>
                  <th className="py-1 font-medium">Address</th>
                  <th className="py-1 font-medium">Tools on</th>
                  <th className="py-1 font-medium">State</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {servers.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2">{row.username ?? row.owner_user_id}</td>
                    <td className="py-2 break-all">{row.host}</td>
                    <td className="py-2">{row.approved_tools}</td>
                    <td className="py-2">
                      <Badge tone={row.enabled && row.status === 'active' ? 'ok' : row.status === 'needs_attention' ? 'danger' : 'muted'}>
                        {plain('mcp_server_status', row.status)}
                      </Badge>
                      {!row.enabled ? (
                        <span className="ml-2 text-xs text-muted-foreground">not available to Josi</span>
                      ) : null}
                      {row.last_error_category ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {plainDetail('connector_error', row.last_error_category)
                            ?? plain('connector_error', row.last_error_category)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      <Button variant="ghost" disabled={busy === row.id} onClick={() => void cutOff(row)}>
                        Cut off
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
