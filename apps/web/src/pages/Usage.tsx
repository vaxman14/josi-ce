// What Josi has cost, said honestly.
//
// Three numbers, never blended into one. M88: a provider-reported charge and a
// figure we worked out from a local price list are different kinds of claim,
// and a self-hosted model has no provider charge at all.
import { useEffect, useState } from 'react';
import { api, type LlmStatus } from '@/lib/api';
import { Badge, Card, CardTitle } from '@/components/ui';

export function Usage() {
  const [status, setStatus] = useState<LlmStatus | null>(null);

  useEffect(() => { void api.get<LlmStatus>('/llm/status').then(setStatus).catch(() => undefined); }, []);

  if (!status) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const { usage, cap } = status;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
      <p className="text-sm text-muted-foreground">Your own usage this month ({usage.month}).</p>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardTitle>Tokens</CardTitle>
          <p className="text-2xl font-semibold tabular-nums">{usage.totalTokens.toLocaleString()}</p>
          <p className="text-xs text-muted-foreground">{usage.calls} request{usage.calls === 1 ? '' : 's'}</p>
        </Card>
        <Card>
          <CardTitle>Provider charges</CardTitle>
          <p className="text-2xl font-semibold tabular-nums">${usage.reportedCostUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">As reported by the provider</p>
        </Card>
        <Card>
          <CardTitle>Estimated</CardTitle>
          <p className="text-2xl font-semibold tabular-nums">${usage.estimatedCostUsd.toFixed(2)}</p>
          <p className="text-xs text-muted-foreground">Worked out locally, not a bill</p>
        </Card>
      </div>

      {usage.selfHostedCalls > 0 ? (
        <Card>
          <CardTitle>Self-hosted</CardTitle>
          <p className="text-sm text-muted-foreground">
            {usage.selfHostedCalls} request{usage.selfHostedCalls === 1 ? '' : 's'} to a model on your own
            hardware — $0 provider charge. Hardware and electricity are not counted here.
          </p>
        </Card>
      ) : null}

      <Card>
        <CardTitle>Budget</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={cap.allowed ? (cap.status === 'ok' ? 'ok' : 'primary') : 'danger'}>
            {cap.status.replace('_', ' ')}
          </Badge>
          <p className="min-w-0 break-words text-sm text-muted-foreground">{cap.message}</p>
        </div>
      </Card>

      {usage.notes.length ? (
        <ul className="space-y-1 text-xs text-muted-foreground">
          {usage.notes.map((note) => <li key={note}>{note}</li>)}
        </ul>
      ) : null}
    </div>
  );
}
