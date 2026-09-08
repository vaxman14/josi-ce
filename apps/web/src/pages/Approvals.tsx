// Things Josi will not do without being told to.
//
// TWO KINDS OF WAITING, ON ONE PAGE, KEPT VISUALLY APART.
//
// The first is a task Josi prepared — an email, a calendar change — where
// approving marks it ready and something else carries it out afterwards.
//
// The second is an outbound request to a connected API, where approving IS the
// sending: one route decides and makes the request in the same breath, so an
// approved call can neither sit unmade nor be made twice. That difference is
// stated on the card rather than left for somebody to discover, because
// "Approve" meaning "do it now, to an outside system" deserves to be read as
// such before it is pressed.
import { useCallback, useEffect, useState } from 'react';
import { api, type Approval } from '@/lib/api';
import { Badge, Button, Card, Empty, ErrorNote } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';

interface PendingCall {
  id: string;
  connectionName: string;
  operationId: string;
  capability: string;
  /** Exactly what would be sent, in words, written from the allowlist row
   * rather than from anything the model said about it. */
  summary: string;
  requestedAt: string;
  expiresAt: string;
}

/** A tool on an MCP server the person connected themselves.
 *
 * Kept apart from the custom API cards even though approving does the same
 * thing — decides and runs in one step — because the words in `summary` came
 * from a different place. There, an administrator wrote what the action does.
 * Here the remote server did, and the card says so. */
interface PendingMcpCall {
  id: string;
  serverName: string;
  toolName: string;
  summary: string;
  requestedAt: string;
  expiresAt: string;
}

export function Approvals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [calls, setCalls] = useState<PendingCall[]>([]);
  const [mcpCalls, setMcpCalls] = useState<PendingMcpCall[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    await Promise.all([
      api.get<{ approvals: Approval[] }>('/assistant/approvals')
        .then((r) => setApprovals(r.approvals)).catch(() => undefined),
      api.get<{ pending: PendingCall[] }>('/custom-apis/pending')
        .then((r) => setCalls(r.pending)).catch(() => undefined),
      api.get<{ pending: PendingMcpCall[] }>('/mcp-servers/pending')
        .then((r) => setMcpCalls(r.pending)).catch(() => undefined),
    ]);
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError('');
    setNotice('');
    try {
      await api.post(`/assistant/approvals/${id}/decide`, { approve });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that');
    } finally {
      setBusy(null);
    }
  }

  async function decideCall(call: PendingCall, approve: boolean) {
    setBusy(call.id);
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ ok?: boolean; status?: number; error?: string }>(
        `/custom-apis/pending/${call.id}/${approve ? 'approve' : 'deny'}`,
      );
      setNotice(approve
        ? (res?.ok === false
          ? `${call.connectionName} was asked and refused the request. Nothing was changed.`
          : `Sent to ${call.connectionName}.`)
        : 'Declined. Nothing was sent.');
      await load();
    } catch (err) {
      // The server writes its errors for people; passing one through beats
      // inventing a friendlier sentence that says less.
      setError(err instanceof Error ? err.message : 'Could not record that');
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function decideMcpCall(call: PendingMcpCall, approve: boolean) {
    setBusy(call.id);
    setError('');
    setNotice('');
    try {
      const res = await api.post<{ ok?: boolean; message?: string }>(
        `/mcp-servers/pending/${call.id}/${approve ? 'approve' : 'deny'}`,
      );
      setNotice(approve
        ? (res?.ok === false
          ? `${call.serverName} was asked and the tool did not succeed. Nothing else was sent.`
          : `Run on ${call.serverName}.`)
        : 'Declined. Nothing was sent.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that');
      await load();
    } finally {
      setBusy(null);
    }
  }

  const nothing = approvals.length === 0 && calls.length === 0 && mcpCalls.length === 0;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p role="status" className="text-sm text-emerald-300">{notice}</p> : null}

      {nothing ? (
        <Empty title="Nothing to approve">
          When Josi wants to do something on your behalf that it should ask about first, it will appear here.
        </Empty>
      ) : null}

      {calls.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Requests to a connected API</h2>
          <p className="text-sm text-muted-foreground">
            These have not happened. Approving one sends it immediately, exactly as described.
          </p>
          <ul className="space-y-2">
            {calls.map((call) => (
              <li key={call.id}>
                <Card>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 text-sm font-medium">{call.connectionName}</span>
                    <Badge tone="danger">{plain('custom_api_capability', call.capability)}</Badge>
                  </div>
                  {/* The exact request, in words, before anybody agrees to it. */}
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">{call.summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expires {new Date(call.expiresAt).toLocaleString()} — an old request is not
                    consent, so it stops being answerable then.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button onClick={() => void decideCall(call, true)} disabled={busy === call.id}>
                      {busy === call.id ? 'Sending…' : 'Approve and send'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void decideCall(call, false)}
                      disabled={busy === call.id}
                    >
                      Decline
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {mcpCalls.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Tools on a server you connected</h2>
          <p className="text-sm text-muted-foreground">
            These have not run. Approving one runs it immediately. The description below is the
            external server&apos;s own — Josi cannot see what the tool actually does.
          </p>
          <ul className="space-y-2">
            {mcpCalls.map((call) => (
              <li key={call.id}>
                <Card>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 text-sm font-medium">{call.serverName}</span>
                    <Badge tone="danger">{call.toolName}</Badge>
                  </div>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm">{call.summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Expires {new Date(call.expiresAt).toLocaleString()} — an old request is not
                    consent, so it stops being answerable then.
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button onClick={() => void decideMcpCall(call, true)} disabled={busy === call.id}>
                      {busy === call.id ? 'Running…' : 'Approve and run'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => void decideMcpCall(call, false)}
                      disabled={busy === call.id}
                    >
                      Decline
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {approvals.length ? (
        <section className="space-y-2">
          {calls.length || mcpCalls.length ? <h2 className="text-sm font-semibold">Work Josi has prepared</h2> : null}
          <ul className="space-y-2">
            {approvals.map((a) => (
              <li key={a.id}>
                <Card>
                  {/* The exact action, in words, before anyone agrees to it. */}
                  <p className="break-words text-sm">{a.summary}</p>
                  <p className="mt-1 text-xs text-muted-foreground">{a.action.replace(/_/g, ' ')}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <Button onClick={() => void decide(a.id, true)} disabled={busy === a.id}>Approve</Button>
                    <Button variant="secondary" onClick={() => void decide(a.id, false)} disabled={busy === a.id}>
                      Decline
                    </Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
