// The installation's own OAuth applications, and the capability ceiling.
//
// Two things this page must not imply. It must not suggest the admin can grant
// a capability — the policy control says "allowed", and turning it on returns
// the choice to each person rather than switching anything on. And it must not
// show anything from inside a connected account: the health table is whose it
// is and whether it works.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface ClientStatus {
  provider: 'google' | 'microsoft';
  configured: boolean;
  clientId: string | null;
  redirectUri: string | null;
}

interface PolicyRow {
  key: string;
  provider: string;
  label: string;
  kind: 'read' | 'write';
  allowed: boolean;
  note: string | null;
}

interface AdminView {
  clients: ClientStatus[];
  policy: PolicyRow[];
  suggestedRedirectUris: Array<{ provider: string; uri: string }>;
}

interface HealthRow {
  id: string;
  username: string;
  provider: string;
  status: string;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: string | null;
}

const LABEL: Record<string, string> = { google: 'Google', microsoft: 'Microsoft 365' };

export function AdminConnectors() {
  const [view, setView] = useState<AdminView | null>(null);
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await api.get<AdminView>('/admin/connectors'));
      setHealth((await api.get<{ connections: HealthRow[] }>('/admin/connectors/connections')).connections);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load connector settings');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function saveClient(provider: string, form: FormData) {
    setError('');
    try {
      await api.put(`/admin/connectors/clients/${provider}`, {
        clientId: form.get('clientId'),
        clientSecret: form.get('clientSecret'),
        redirectUri: form.get('redirectUri'),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    }
  }

  async function setPolicy(capability: string, allowed: boolean) {
    setError('');
    try {
      await api.put(`/admin/connectors/policy/${capability}`, { allowed });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    }
  }

  async function revoke(id: string) {
    setError('');
    try {
      await api.del(`/admin/connectors/connections/${id}`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect that');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Connectors</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!view ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {view?.clients.map((client) => {
        const suggested = view.suggestedRedirectUris.find((u) => u.provider === client.provider)?.uri ?? '';
        return (
          <Card key={client.provider}>
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <CardTitle>{LABEL[client.provider]} application</CardTitle>
              <Badge tone={client.configured ? 'ok' : 'muted'}>
                {client.configured ? 'configured' : 'not set up'}
              </Badge>
            </div>
            <p className="mb-3 text-sm text-muted-foreground">
              Josi ships with no application of its own — you register one with {LABEL[client.provider]} and
              paste its credentials here. The secret is encrypted with this installation's master key and is
              never shown again.
            </p>
            <p className="mb-3 break-all text-xs text-muted-foreground">
              Register this exact callback URL: <code>{suggested}</code>
            </p>
            <form
              onSubmit={(e) => { e.preventDefault(); void saveClient(client.provider, new FormData(e.currentTarget)); }}
              className="space-y-3"
            >
              <div>
                <label className="mb-1 block text-sm" htmlFor={`cid-${client.provider}`}>Client ID</label>
                <Input id={`cid-${client.provider}`} name="clientId" defaultValue={client.clientId ?? ''} required />
              </div>
              <div>
                <label className="mb-1 block text-sm" htmlFor={`csec-${client.provider}`}>Client secret</label>
                <Input id={`csec-${client.provider}`} name="clientSecret" type="password"
                       autoComplete="off" required
                       placeholder={client.configured ? 'stored — enter a new one to replace it' : ''} />
              </div>
              <div>
                <label className="mb-1 block text-sm" htmlFor={`uri-${client.provider}`}>Redirect URI</label>
                <Input id={`uri-${client.provider}`} name="redirectUri"
                       defaultValue={client.redirectUri ?? suggested} required />
              </div>
              <Button type="submit">Save</Button>
            </form>
          </Card>
        );
      })}

      <Card>
        <CardTitle>What people may switch on</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          This can only take permissions away. Marking something allowed does not switch it on for anyone —
          it returns the choice to each person, and someone who never enabled it still has not.
        </p>
        <ul className="space-y-3">
          {view?.policy.map((row) => (
            <li key={row.key} className="flex min-w-0 flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 text-sm">
                {row.label}
                {row.kind === 'write' ? <span className="ml-2 text-xs text-muted-foreground">writes</span> : null}
              </span>
              <Button
                variant={row.allowed ? 'secondary' : 'danger'}
                onClick={() => void setPolicy(row.key, !row.allowed)}
                aria-pressed={!row.allowed}
              >
                {row.allowed ? 'Allowed' : 'Switched off'}
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardTitle>Connection health</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          Whose connection it is and whether it works. Not the account address, not what is inside it.
        </p>
        {health.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has connected an account yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[24rem] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Person</th>
                  <th className="py-1 font-medium">Provider</th>
                  <th className="py-1 font-medium">State</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {health.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2">{row.username}</td>
                    <td className="py-2">{LABEL[row.provider] ?? row.provider}</td>
                    <td className="py-2">
                      <Badge tone={row.status === 'active' ? 'ok' : 'danger'}>{row.status}</Badge>
                      {row.last_error_category ? (
                        <span className="ml-2 text-xs text-muted-foreground">{row.last_error_category}</span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      <Button variant="ghost" onClick={() => void revoke(row.id)}>Disconnect</Button>
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
