import { useState } from 'react';
import { api } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { Button, Card, CardTitle, ErrorNote } from '@/components/ui';

interface BackupRow {
  id: string;
  kind: 'full' | 'portable';
  byte_size: number | string;
  state: 'running' | 'complete' | 'failed';
  error_category: string | null;
  includes_recovery_copies: boolean;
  master_key_confirmed: boolean;
  created_at: string;
  completed_at: string | null;
}

interface BackupList {
  backups: BackupRow[];
  masterKeyGuidance: string;
}

interface RestorePreflight {
  masterKeyPresent: boolean;
  guidance: string;
  warning: string;
}

const bytes = (value: number | string) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  return `${(n / 1024 ** power).toFixed(power ? 1 : 0)} ${units[power]}`;
};

export function AdminBackups() {
  const list = useResource<BackupList>('/ops/admin/backups');
  const preflight = useResource<RestorePreflight>('/ops/admin/restore/preflight');
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmedKey, setConfirmedKey] = useState(false);

  async function create(kind: 'full' | 'portable') {
    setWorking(kind); setError(''); setNotice('');
    try {
      const result = await api.post<{ description: string }>('/ops/admin/backups', {
        kind, masterKeyConfirmed: confirmedKey,
      });
      setNotice(result.description);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The backup could not be created.');
    } finally { setWorking(''); }
  }

  async function restore(row: BackupRow) {
    if (!window.confirm('Restore this backup? This replaces the current database and cannot be undone.')) return;
    const typed = window.prompt('Type restore to confirm.');
    if (typed !== 'restore') return;
    setWorking(row.id); setError(''); setNotice('');
    try {
      const result = await api.post<{ credentialsRecovered: boolean; rowsRestored: number; warning?: string }>(
        '/ops/admin/restore', { backupId: row.id, confirm: 'restore' },
      );
      setNotice(result.warning ?? `Restore completed. ${result.rowsRestored} rows restored; encrypted credentials recovered.`);
      list.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The restore could not be completed.');
    } finally { setWorking(''); }
  }

  return <div className="mx-auto w-full min-w-0 max-w-4xl space-y-4">
    <div>
      <h1 className="text-xl font-semibold tracking-tight">Backups</h1>
      <p className="mt-1 text-sm text-muted-foreground">Create restorable snapshots and prove they can come back before you need them.</p>
    </div>

    <Card>
      <CardTitle>Master key</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">{list.data?.masterKeyGuidance ?? preflight.data?.guidance}</p>
      <label className="flex min-h-11 items-center gap-3 text-sm font-medium">
        <input type="checkbox" checked={confirmedKey} onChange={(e) => setConfirmedKey(e.target.checked)} className="h-5 w-5" />
        I have stored the master key separately from these backups
      </label>
      {preflight.state === 'ready' && !preflight.data?.masterKeyPresent ?
        <ErrorNote>The master key is not mounted in this container. A restore can recover data, but not encrypted credentials.</ErrorNote> : null}
    </Card>

    <Card>
      <CardTitle>Create backup</CardTitle>
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => void create('full')} disabled={!!working || !confirmedKey}>{working === 'full' ? 'Creating…' : 'Create full backup'}</Button>
        <Button variant="secondary" onClick={() => void create('portable')} disabled={!!working}>{working === 'portable' ? 'Exporting…' : 'Create portable export'}</Button>
      </div>
      {!confirmedKey ? <p className="mt-3 text-sm text-amber-300">Confirm the separately stored master key before creating a restorable backup.</p> : null}
    </Card>

    {error ? <ErrorNote>{error}</ErrorNote> : null}
    {notice ? <Card><p className="text-sm text-emerald-300">{notice}</p></Card> : null}

    <Card>
      <CardTitle>Backup history</CardTitle>
      {list.state === 'loading' ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {list.state === 'error' || list.state === 'timeout' ? <ErrorNote>{list.message}</ErrorNote> : null}
      {list.state === 'ready' && !list.data?.backups.length ? <p className="text-sm text-muted-foreground">No backups yet.</p> : null}
      <div className="space-y-3">
        {list.data?.backups.map((row) => <div key={row.id} className="rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-medium">{row.kind === 'full' ? 'Full backup' : 'Portable export'} · {row.state}</p>
              <p className="text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString()} · {bytes(row.byte_size)}</p>
            </div>
            {row.kind === 'full' && row.state === 'complete' ?
              <Button variant="secondary" disabled={!!working} onClick={() => void restore(row)}>{working === row.id ? 'Restoring…' : 'Restore'}</Button> : null}
          </div>
          {row.error_category ? <p className="mt-2 text-sm text-destructive">Failed: {row.error_category.replaceAll('_', ' ')}</p> : null}
          {!row.master_key_confirmed && row.kind === 'full' ? <p className="mt-2 text-sm text-amber-300">Master key backup was not confirmed when this was created.</p> : null}
        </div>)}
      </div>
    </Card>
  </div>;
}
