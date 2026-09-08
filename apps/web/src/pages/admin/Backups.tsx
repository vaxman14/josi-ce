import { useState } from 'react';
import { api } from '@/lib/api';
import { useResource } from '@/lib/useResource';
import { plain } from '@/lib/plainLanguage';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

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

interface Destination {
  id: string; name: string; kind: 'local'|'nas'|'s3'|'r2'|'b2'; repository: string;
  secret_ref: string; enabled: boolean;
}
interface DestinationList {
  destinations: Destination[];
  schedules: Array<{ destination_id:string; cadence:'daily'|'weekly'; next_run_at:string }>;
  runs: Array<{ id:string; destination_id:string; state:string; error_category:string|null; started_at:string }>;
  secretRoot: string;
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
  const destinations = useResource<DestinationList>('/ops/admin/backup-destinations');
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmedKey, setConfirmedKey] = useState(false);
  const [destinationId, setDestinationId] = useState('');
  const [destinationName, setDestinationName] = useState('');
  const [destinationKind, setDestinationKind] = useState<Destination['kind']>('local');
  const [repository, setRepository] = useState('/backup-targets/josi');
  const [secretRef, setSecretRef] = useState('primary');

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

  async function addDestination() {
    setWorking('destination'); setError(''); setNotice('');
    try {
      const result = await api.post<{ destination:Destination }>('/ops/admin/backup-destinations', {
        name: destinationName, kind: destinationKind, repository, secretRef,
      });
      setDestinationId(result.destination.id); setDestinationName('');
      setNotice(`Destination “${result.destination.name}” added. Mount its credential files before the first run.`);
      destinations.reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'The destination could not be added.'); }
    finally { setWorking(''); }
  }

  async function saveSchedule() {
    if (!destinationId) return;
    setWorking('schedule'); setError(''); setNotice('');
    try {
      await api.put(`/ops/admin/backup-destinations/${destinationId}/schedule`, {
        cadence: 'daily', hourUtc: 3, keepDaily: 7, keepWeekly: 4, keepMonthly: 6,
      });
      setNotice('Daily backup scheduled for 03:00 UTC with 7 daily, 4 weekly and 6 monthly snapshots.');
      destinations.reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'The schedule could not be saved.'); }
    finally { setWorking(''); }
  }

  async function replicate(row: BackupRow) {
    if (!destinationId) { setError('Choose a backup destination first.'); return; }
    setWorking(`replicate-${row.id}`); setError(''); setNotice('');
    try {
      await api.post(`/ops/admin/backups/${row.id}/replicate`, { destinationId });
      setNotice('Backup copied to the Restic repository, retention applied, and repository integrity checked.');
      destinations.reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'The backup could not be copied.'); }
    finally { setWorking(''); }
  }

  async function verifyOffsite(row: BackupRow) {
    if (!destinationId) return;
    setWorking(`verify-${row.id}`); setError(''); setNotice('');
    try {
      await api.post(`/ops/admin/backups/${row.id}/verify-offsite`, { destinationId });
      setNotice('Restore test passed: Restic read the snapshot back and its checksum exactly matches the original archive.');
      destinations.reload();
    } catch (err) { setError(err instanceof Error ? err.message : 'The restore test failed.'); }
    finally { setWorking(''); }
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

    <Card>
      <CardTitle>Backup destinations</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">Local disks and NAS shares must be mounted beneath /backup-targets. S3, Cloudflare R2 and Backblaze B2 use Restic credential files—secrets are never stored in the database.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Input aria-label="Destination name" placeholder="Destination name" value={destinationName} onChange={(e) => setDestinationName(e.target.value)} />
        <select aria-label="Destination type" value={destinationKind} onChange={(e) => setDestinationKind(e.target.value as Destination['kind'])} className="min-h-11 rounded-md border border-input bg-background px-3 text-base sm:text-sm">
          <option value="local">Local disk</option><option value="nas">NAS share</option><option value="s3">Amazon S3</option><option value="r2">Cloudflare R2</option><option value="b2">Backblaze B2</option>
        </select>
        <Input aria-label="Restic repository" placeholder="/backup-targets/josi or s3:https://…" value={repository} onChange={(e) => setRepository(e.target.value)} />
        <Input aria-label="Secret reference" placeholder="Secret reference" value={secretRef} onChange={(e) => setSecretRef(e.target.value)} />
      </div>
      <Button className="mt-3" disabled={!!working || !destinationName || !repository || !secretRef} onClick={() => void addDestination()}>{working === 'destination' ? 'Adding…' : 'Add destination'}</Button>
      <div className="mt-4 space-y-2">
        {destinations.data?.destinations.map((item) => <label key={item.id} className="flex min-h-11 items-center gap-3 rounded-md border border-border p-3">
          <input type="radio" name="backup-destination" checked={destinationId === item.id} onChange={() => setDestinationId(item.id)} className="h-5 w-5" />
          <span className="min-w-0"><span className="block font-medium">{item.name} · {item.kind.toUpperCase()}</span><span className="block truncate text-xs text-muted-foreground">{item.repository}</span></span>
        </label>)}
      </div>
      {destinationId ? <Button variant="secondary" className="mt-3" disabled={!!working} onClick={() => void saveSchedule()}>{working === 'schedule' ? 'Saving…' : 'Schedule daily backup'}</Button> : null}
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
              <p className="font-medium">{row.kind === 'full' ? 'Full backup' : 'Portable export'} · {plain('backup_state', row.state)}</p>
              <p className="text-xs text-muted-foreground">{new Date(row.created_at).toLocaleString()} · {bytes(row.byte_size)}</p>
            </div>
            {row.kind === 'full' && row.state === 'complete' ?
              <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={!!working} onClick={() => void restore(row)}>{working === row.id ? 'Restoring…' : 'Restore'}</Button>
              <Button variant="secondary" disabled={!!working || !destinationId} onClick={() => void replicate(row)}>{working === `replicate-${row.id}` ? 'Copying…' : 'Copy off-host'}</Button>
              <Button variant="secondary" disabled={!!working || !destinationId} onClick={() => void verifyOffsite(row)}>{working === `verify-${row.id}` ? 'Testing…' : 'Test off-host restore'}</Button></div> : null}
          </div>
          {row.error_category ? <p className="mt-2 text-sm text-destructive">Failed: {row.error_category.replaceAll('_', ' ')}</p> : null}
          {!row.master_key_confirmed && row.kind === 'full' ? <p className="mt-2 text-sm text-amber-300">Master key backup was not confirmed when this was created.</p> : null}
        </div>)}
      </div>
    </Card>
  </div>;
}
