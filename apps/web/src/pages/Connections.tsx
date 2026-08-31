// Connected accounts.
//
// The table and the authorization model exist since Phase 1; the OAuth flow
// that would put something in them does not. So this page shows what is
// connected — nothing, on a fresh installation — and says plainly that
// connecting is not available yet.
//
// What it deliberately does NOT have is a Connect button. A control that looks
// pressable and does nothing is the placeholder the acceptance criteria forbid,
// and it is also how the engine's tenants ended up staring at a
// redirect_uri_mismatch.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Card, CardTitle, NotYet } from '@/components/ui';

interface Connection {
  id: string;
  provider: string;
  account: string | null;
  status: string;
  lastCheckOk: boolean | null;
}

export function Connections() {
  const [connections, setConnections] = useState<Connection[]>([]);

  useEffect(() => {
    void api.get<{ connections: Connection[] }>('/connections')
      .then((r) => setConnections(r.connections)).catch(() => undefined);
  }, []);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Connections</h1>
      <p className="text-sm text-muted-foreground">
        Your own Google or Microsoft account, connected by you. An administrator can see whether a
        connection is working and can revoke it, but cannot read what is inside it.
      </p>

      {connections.length > 0 ? (
        <ul className="space-y-2">
          {connections.map((c) => (
            <li key={c.id}>
              <Card>
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <span className="min-w-0 truncate text-sm font-medium">{c.provider}</span>
                  <Badge tone={c.lastCheckOk ? 'ok' : 'muted'}>{c.status}</Badge>
                </div>
                {c.account ? <p className="truncate text-sm text-muted-foreground">{c.account}</p> : null}
              </Card>
            </li>
          ))}
        </ul>
      ) : null}

      <NotYet title="Connecting an account is not available in this release">
        Josi CE 0.1 is a Community Preview. Google and Microsoft connections need the operator to register
        their own OAuth application, and that flow ships in a later release. There is nothing to press here
        yet — when it exists, it will appear on this page.
      </NotYet>

      <Card>
        <CardTitle>Storage providers</CardTitle>
        <p className="text-sm text-muted-foreground">
          Google Drive and OneDrive are planned. Box and Dropbox may follow. None of them are available yet.
        </p>
      </Card>
    </div>
  );
}
