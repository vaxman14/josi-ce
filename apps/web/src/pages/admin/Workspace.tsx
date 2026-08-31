import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface Workspace { name: string; timezone: string }

export function AdminWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void api.get<{ workspace: Workspace }>('/admin/workspace').then((r) => setWorkspace(r.workspace)).catch(() => undefined);
  }, []);

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setError('');
    setSaved(false);
    try {
      const r = await api.patch<{ workspace: Workspace }>('/admin/workspace', {
        name: form.get('name'), timezone: form.get('timezone'),
      });
      setWorkspace(r.workspace);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    }
  }

  if (!workspace) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Workspace</h1>
      <Card>
        <CardTitle>Business profile</CardTitle>
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm" htmlFor="ws-name">Name</label>
            <Input id="ws-name" name="name" defaultValue={workspace.name} required />
          </div>
          <div>
            <label className="mb-1 block text-sm" htmlFor="ws-tz">Time zone</label>
            <Input id="ws-tz" name="timezone" defaultValue={workspace.timezone} required />
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button type="submit">Save</Button>
          {saved ? <p className="text-sm text-emerald-400">Saved.</p> : null}
        </form>
      </Card>

      <Card>
        <CardTitle>Branding</CardTitle>
        <p className="text-sm text-muted-foreground">
          The Josi name, shepherd mark and wordmark are part of this product and are not replaceable.
          The code is AGPL; the identity is not. Created and published by SOCAL RECEPTIONIST LLC.
        </p>
      </Card>
    </div>
  );
}
