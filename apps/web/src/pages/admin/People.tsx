// Who is in this workspace.
import { useEffect, useState } from 'react';
import { api, type User } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

export function AdminPeople() {
  const [users, setUsers] = useState<User[]>([]);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');

  const load = () => api.get<{ users: User[] }>('/admin/users').then((r) => setUsers(r.users)).catch(() => undefined);
  useEffect(() => { void load(); }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    try {
      const result = await api.post<{ inviteLink: string }>('/admin/users', {
        email: form.get('email'), username: form.get('username'),
      });
      // CE has no mail delivery until Phase 8, so the link is handed over
      // rather than sent. Shown here because there is nowhere else for it to go
      // — and said plainly rather than implying an email went out.
      setInvite(result.inviteLink);
      event.currentTarget.reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add them');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">People</h1>

      <Card>
        <CardTitle>Add someone</CardTitle>
        <form onSubmit={create} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm" htmlFor="new-email">Email</label>
            <Input id="new-email" name="email" type="email" inputMode="email" required />
          </div>
          <div>
            <label className="mb-1 block text-sm" htmlFor="new-username">Username</label>
            <Input id="new-username" name="username" autoCapitalize="none" required />
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button type="submit">Add person</Button>
        </form>
        {invite ? (
          <div className="mt-3 rounded-md border border-border bg-secondary/40 p-3">
            <p className="text-sm font-medium">Give them this link</p>
            <p className="mt-1 text-xs text-muted-foreground">
              No email was sent — this installation cannot send mail yet. The link sets their password once.
            </p>
            <code className="mt-2 block break-all text-xs">{invite}</code>
          </div>
        ) : null}
      </Card>

      <ul className="space-y-2">
        {users.map((u) => (
          <li key={u.id}>
            <Card>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm font-medium">{u.username}</span>
                <Badge tone={u.role === 'super_admin' ? 'primary' : 'muted'}>
                  {u.role === 'super_admin' ? 'administrator' : 'member'}
                </Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">{u.email}</p>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
