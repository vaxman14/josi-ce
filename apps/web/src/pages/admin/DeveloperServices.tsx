// Administration for developer services.
//
// Two things, and it must not imply a third.
//
//   1. A deny-only ceiling. Switching a service off stops anyone connecting it
//      and stops Josi using the connections that already exist — the routes
//      that open a sealed token check the ceiling, not only the one that stores
//      it. Switching it back on grants nothing: it returns the choice to each
//      person, who still has to paste their own token.
//   2. Health. Whose connection it is and whether it works. Not the account
//      handle, not the project, not what the token covers, and not the token.
//
// The third thing, which does not exist here on purpose: connecting a service
// on somebody else's behalf. There is no route for it, and an installation-wide
// GitHub token is exactly the "preset, silently configured" shape this whole
// feature was asked to avoid.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface PolicyRow {
  service: string;
  label: string;
  allowed: boolean;
  note: string | null;
}

interface HealthRow {
  id: string;
  owner_user_id: string;
  username: string | null;
  service: string;
  status: string;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: string | null;
  created_at: string;
}

export function AdminDeveloperServices() {
  const [policy, setPolicy] = useState<PolicyRow[]>([]);
  const [connections, setConnections] = useState<HealthRow[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ policy: PolicyRow[]; connections: HealthRow[] }>(
        '/admin/developer-services',
      );
      setPolicy(res.policy);
      setConnections(res.connections);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load developer services');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function setAllowed(row: PolicyRow, allowed: boolean) {
    setBusy(row.service);
    setError('');
    try {
      await api.put(`/admin/developer-services/policy/${row.service}`, { allowed });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that');
    } finally {
      setBusy('');
    }
  }

  async function revoke(row: HealthRow) {
    setBusy(row.id);
    setError('');
    try {
      await api.del(`/admin/developer-services/connections/${row.id}`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not disconnect that');
    } finally {
      setBusy('');
    }
  }

  const labelFor = (service: string) => policy.find((p) => p.service === service)?.label ?? service;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Developer services</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      <Card>
        <CardTitle>What this installation permits</CardTitle>
        <p className="mb-3 text-sm text-muted-foreground">
          This can only take permissions away. Switching a service off stops anyone connecting it
          and stops Josi using the connections that already exist; their owners can still take
          their tokens back. Switching a service on does not switch it on for anyone — each person
          still has to create a token in their own account and connect it themselves. Nothing here
          is preset.
        </p>
        <ul className="space-y-3">
          {policy.map((row) => (
            <li key={row.service} className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-t border-border pt-3 first:border-0 first:pt-0">
              <span className="min-w-0 text-sm font-medium">{row.label}</span>
              <Button
                variant={row.allowed ? 'secondary' : 'danger'}
                disabled={busy === row.service}
                aria-pressed={!row.allowed}
                onClick={() => void setAllowed(row, !row.allowed)}
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
          Whose connection it is and whether it works. Not the account it points at, and never the
          token — that stays encrypted and is not readable from here.
        </p>
        {connections.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nobody has connected a developer service yet.</p>
        ) : (
          <div className="-mx-4 overflow-x-auto px-4">
            <table className="w-full min-w-[24rem] text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="py-1 font-medium">Person</th>
                  <th className="py-1 font-medium">Service</th>
                  <th className="py-1 font-medium">State</th>
                  <th className="py-1" />
                </tr>
              </thead>
              <tbody>
                {connections.map((row) => (
                  <tr key={row.id} className="border-t border-border">
                    <td className="py-2">{row.username ?? row.owner_user_id}</td>
                    <td className="py-2">{labelFor(row.service)}</td>
                    <td className="py-2">
                      <Badge tone={row.status === 'active' ? 'ok' : 'danger'}>
                        {plain('connection_status', row.status)}
                      </Badge>
                      {row.last_error_category ? (
                        <span className="ml-2 text-xs text-muted-foreground">
                          {plainDetail('connector_error', row.last_error_category)
                            ?? plain('connector_error', row.last_error_category)}
                        </span>
                      ) : null}
                    </td>
                    <td className="py-2 text-right">
                      <Button variant="ghost" disabled={busy === row.id} onClick={() => void revoke(row)}>
                        Disconnect
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
