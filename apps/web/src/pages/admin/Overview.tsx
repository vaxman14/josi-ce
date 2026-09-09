// The administrator's view of the assistant.
//
// Counts and health. There is deliberately no way from here into anybody's
// conversation, task or contact — the server answers 404 for those the same as
// it would for a stranger, and this page does not offer a link that would.
import { useResource } from '@/lib/useResource';
import { ResourceFallback } from '@/components/ResourceFallback';
import { Card, CardTitle } from '@/components/ui';

interface AdminAssistant {
  counts: { threads: number; messages: number; tasks: number; openTasks: number; contacts: number };
  perUser: Array<{ user_id: string; username: string; tasks: number; threads: number }>;
  metrics: { tasks: number; interrupt_rate: number; correction_rate: number; reviewed: number };
}

export function AdminOverview() {
  // Every outcome named. This page used to swallow the failure and key a
  // spinner on `data === null`, so any failed fetch — including one killed by
  // a poisoned cached HTTPS redirect — was a page loading forever.
  const resource = useResource<AdminAssistant>('/admin/assistant');
  const data = resource.data;

  if (resource.state !== 'ready' || !data) {
    return (
      <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
        <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
        <ResourceFallback resource={resource} />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Overview</h1>
      <p className="text-sm text-muted-foreground">
        How much the workspace is using Josi. Not what anybody said to it — that stays with the person
        whose conversation it is.
      </p>

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-4">
        {[
          ['Conversations', data.counts.threads],
          ['Messages', data.counts.messages],
          ['Tasks', data.counts.tasks],
          ['Open', data.counts.openTasks],
        ].map(([label, value]) => (
          <Card key={String(label)}>
            <p className="text-xs text-muted-foreground">{label}</p>
            <p className="text-2xl font-semibold tabular-nums">{value as number}</p>
          </Card>
        ))}
      </div>

      <Card>
        <CardTitle>Is it working?</CardTitle>
        <p className="text-sm text-muted-foreground">
          Interrupt rate {(data.metrics.interrupt_rate * 100).toFixed(0)}% — how often Josi had to come back
          and ask. Correction rate {(data.metrics.correction_rate * 100).toFixed(0)}% of the
          {' '}{data.metrics.reviewed} task{data.metrics.reviewed === 1 ? '' : 's'} someone reviewed — how
          often they had to fix it. Neither number means much without the other.
        </p>
      </Card>

      <Card>
        <CardTitle>Per person</CardTitle>
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[20rem] text-sm">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="py-1 font-medium">Person</th>
                <th className="py-1 text-right font-medium">Conversations</th>
                <th className="py-1 text-right font-medium">Tasks</th>
              </tr>
            </thead>
            <tbody>
              {data.perUser.map((u) => (
                <tr key={u.user_id} className="border-t border-border">
                  <td className="py-2">{u.username}</td>
                  <td className="py-2 text-right tabular-nums">{u.threads}</td>
                  <td className="py-2 text-right tabular-nums">{u.tasks}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
