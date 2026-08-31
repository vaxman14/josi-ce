// What is waiting for me.
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Approval, type LlmStatus, type Task } from '@/lib/api';
import { Badge, Card, CardTitle, Empty } from '@/components/ui';
import { useAuth } from '@/lib/auth';

export function Home() {
  const { user } = useAuth();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [status, setStatus] = useState<LlmStatus | null>(null);

  useEffect(() => {
    void api.get<{ tasks: Task[] }>('/assistant/tasks').then((r) => setTasks(r.tasks)).catch(() => undefined);
    void api.get<{ approvals: Approval[] }>('/assistant/approvals').then((r) => setApprovals(r.approvals)).catch(() => undefined);
    void api.get<LlmStatus>('/llm/status').then(setStatus).catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">
        Hello{user?.display_name ? `, ${user.display_name}` : ''}
      </h1>

      {/* Honest about whether Josi can do anything at all right now. */}
      {status && !status.ready ? (
        <Card className="border-primary/40">
          <CardTitle>Josi is not ready yet</CardTitle>
          <p className="text-sm text-muted-foreground">
            {status.disabledFeatures[0]?.reason ?? 'No model has been set up on this installation.'}
          </p>
        </Card>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <CardTitle>Waiting on you</CardTitle>
          {approvals.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing needs your approval.</p>
          ) : (
            <ul className="space-y-2">
              {approvals.slice(0, 4).map((a) => (
                <li key={a.id} className="text-sm">
                  <Link className="underline underline-offset-2" to="/app/approvals">{a.summary}</Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardTitle>Open tasks</CardTitle>
          {tasks.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing in progress.</p>
          ) : (
            <ul className="space-y-2">
              {tasks.slice(0, 4).map((t) => (
                <li key={t.id} className="flex min-w-0 items-center justify-between gap-2 text-sm">
                  <span className="truncate">{t.template_key.replace(/_/g, ' ')}</span>
                  <Badge>{t.state}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {tasks.length === 0 && approvals.length === 0 ? (
        <Empty title="Nothing is waiting">
          Start by telling Josi what you need on the <Link className="underline" to="/app/talk">Talk</Link> page.
        </Empty>
      ) : null}
    </div>
  );
}
