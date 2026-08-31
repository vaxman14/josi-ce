// The model this installation uses.
//
// Two things this page must never do: claim a model works before it has been
// tested, and offer a subscription option that has no compliant path. Both are
// server-enforced; this reflects them.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';

interface Provider {
  provider: string;
  model: string;
  active: boolean;
  probedAt: string | null;
  capabilities: { chat: boolean; structuredOutput: boolean; toolCalling: boolean; contextTokens: number | null } | null;
  probeSteps: Array<{ id: string; label: string; passed: boolean; detail: string }>;
}

interface AdminLlm {
  primary: Provider | null;
  fallback: Provider | null;
  localOnly: boolean;
  disabledFeatures: Array<{ feature: string; reason: string }>;
  subscriptionOptions: Array<{ id: string; label: string; available: boolean; reason: string }>;
}

export function AdminModel() {
  const [data, setData] = useState<AdminLlm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.get<AdminLlm>('/admin/llm').then(setData).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  async function probe() {
    setBusy(true);
    setError('');
    try {
      await api.post('/admin/llm/providers/primary/probe');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The test could not run');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      {/* The heading renders before the data does. A page that withholds its
          own title until a fetch resolves leaves the person looking at bare
          "Loading…" with no idea where they are, and gives a screen reader
          nothing to announce. */}
      <h1 className="text-xl font-semibold tracking-tight">Model</h1>
      {!data ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {data ? (
        <>

      <Card>
        <CardTitle>Primary</CardTitle>
        {data.primary ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{data.primary.provider} · {data.primary.model}</span>
              <Badge tone={data.primary.active ? 'ok' : 'danger'}>
                {data.primary.active ? 'tested and in use' : 'not tested'}
              </Badge>
            </div>
            {!data.primary.active ? (
              <p className="mt-2 text-sm text-muted-foreground">
                Josi will not use a model it has not tested. Run the test to see what it can actually do.
              </p>
            ) : null}
            {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
            <div className="mt-3">
              <Button onClick={() => void probe()} disabled={busy}>{busy ? 'Testing…' : 'Test this model'}</Button>
            </div>
            {data.primary.probeSteps?.length ? (
              <ul className="mt-3 space-y-1 text-sm">
                {data.primary.probeSteps.map((s) => (
                  <li key={s.id} className="flex min-w-0 gap-2">
                    <span aria-hidden>{s.passed ? '✓' : '✗'}</span>
                    <span className="min-w-0 break-words">
                      <span className="font-medium">{s.label}</span> — {s.detail}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No model is configured. It is set during installation.</p>
        )}
      </Card>

      {data.disabledFeatures.length ? (
        <Card>
          <CardTitle>Switched off, and why</CardTitle>
          <ul className="space-y-2 text-sm text-muted-foreground">
            {data.disabledFeatures.map((f) => (
              <li key={f.feature}><span className="font-medium text-foreground">{f.feature.replace(/_/g, ' ')}</span> — {f.reason}</li>
            ))}
          </ul>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Using a Claude or ChatGPT subscription</CardTitle>
        <ul className="space-y-3">
          {data.subscriptionOptions.map((o) => (
            <li key={o.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-muted-foreground">{o.label}</span>
                <Badge>unavailable</Badge>
              </div>
              {/* Not a disabled button. There is nothing to press, and the
                  reason is the real one rather than "coming soon". */}
              <p className="mt-1 text-sm text-muted-foreground">{o.reason}</p>
            </li>
          ))}
        </ul>
      </Card>
        </>
      ) : null}
    </div>
  );
}
