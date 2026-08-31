// Things Josi will not do without being told to.
import { useEffect, useState } from 'react';
import { api, type Approval } from '@/lib/api';
import { Button, Card, Empty, ErrorNote } from '@/components/ui';

export function Approvals() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = () =>
    api.get<{ approvals: Approval[] }>('/assistant/approvals').then((r) => setApprovals(r.approvals)).catch(() => undefined);

  useEffect(() => { void load(); }, []);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError('');
    try {
      await api.post(`/assistant/approvals/${id}/decide`, { approve });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not record that');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}

      {approvals.length === 0 ? (
        <Empty title="Nothing to approve">
          When Josi wants to do something on your behalf that it should ask about first, it will appear here.
        </Empty>
      ) : (
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
      )}
    </div>
  );
}
