// Restoring a backup: from the backup folder the container was given, or from a
// file on this computer.
//
// Used in two places. On a fresh server (`mode="setup"`), before anyone has an
// account: pick a file, type the backup password, and everything comes back,
// including connected accounts when the backup carries the installation key. On
// a running one (`mode="admin"`), the file is looked at first and a restore
// replaces everything here, so it asks first.
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Button, ErrorNote, Input } from '@/components/ui';

interface FolderFile { name: string; byteSize: number; modifiedAt: string; encrypted: boolean }
interface Outcome { ok: boolean; credentialsRecovered: boolean; restartNeeded?: boolean; warning?: string | null; attachmentsRestored?: number }
interface Staged {
  stagedId: string; encrypted: boolean; warnings: string[]; refusals: string[]; carriesMasterKey: boolean; filename: string;
  manifest: { josiVersion: string; createdAt: string };
}

function size(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** After a restore that replaced the installation key the services restart; wait until the server answers, then reload. */
async function waitForServer(): Promise<void> {
  await new Promise((r) => setTimeout(r, 6000));
  for (let i = 0; i < 60; i += 1) {
    const ok = await fetch('/api/onboarding/state', { cache: 'no-store' }).then((r) => r.ok).catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export function RestoreBackup({ mode, onCancel }: { mode: 'setup' | 'admin'; onCancel?: () => void }) {
  const [files, setFiles] = useState<FolderFile[] | null>(null);
  const [configured, setConfigured] = useState(false);
  const [picked, setPicked] = useState<string>('');
  const [password, setPassword] = useState('');
  const [staged, setStaged] = useState<Staged | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Outcome | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const path = mode === 'setup' ? '/setup/restore/folder' : '/ops/admin/backups/folder';
    api.get<{ configured: boolean; files: FolderFile[] }>(path)
      .then((r) => { setConfigured(r.configured); setFiles(r.files); if (r.files[0]) setPicked(r.files[0].name); })
      .catch(() => setFiles([]));
  }, [mode]);

  const chosen = files?.find((f) => f.name === picked);
  const needsPassword = staged ? staged.encrypted : chosen ? chosen.encrypted : false;

  async function finish(out: Outcome) {
    setDone(out);
    if (out.restartNeeded) { await waitForServer(); }
    else await new Promise((r) => setTimeout(r, 1500));
    window.location.assign('/');
  }

  async function restoreFromFolder() {
    setBusy(true); setError('');
    try {
      const out = mode === 'setup'
        ? await api.post<Outcome>('/setup/restore/folder', { file: picked, passphrase: password || undefined })
        : await api.post<Outcome>('/ops/admin/restore', { folderFile: picked, passphrase: password || undefined, confirm: 'restore' });
      await finish(out);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'The backup could not be restored'); setBusy(false); }
  }

  async function chooseUpload(file: File) {
    setBusy(true); setError('');
    try {
      const body = new FormData();
      body.append('archive', file);
      if (password) body.append('passphrase', password);
      if (mode === 'setup') { await finish(await api.upload<Outcome>('/setup/restore', body)); return; }
      const inspected = await api.upload<Staged>('/ops/admin/restore/stage', body);
      setStaged(inspected); setBusy(false);
    } catch (err) { setError(err instanceof ApiError ? err.message : 'That file could not be read'); setBusy(false); }
  }

  async function confirmStaged() {
    if (!staged) return;
    setBusy(true); setError('');
    try { await finish(await api.post<Outcome>('/ops/admin/restore', { stagedId: staged.stagedId, passphrase: password || undefined, confirm: 'restore' })); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'The backup could not be restored'); setBusy(false); }
  }

  if (done) {
    return (
      <div role="status" aria-live="polite" className="space-y-2 text-sm">
        <p className="font-medium">Your backup is back.</p>
        <p className="text-muted-foreground">
          {done.credentialsRecovered
            ? 'Connected accounts and saved logins came back with it.'
            : 'Your data is back, but connected accounts and saved logins will need to be connected again.'}
        </p>
        {done.warning ? <p className="text-muted-foreground">{done.warning}</p> : null}
        <p className="text-muted-foreground">{done.restartNeeded ? 'Josi is restarting. This page reloads when it is ready.' : 'Opening Josi…'}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {files && files.length ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="restore-file">Backups found in your backup folder</label>
          <select id="restore-file" className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm" value={picked}
                  onChange={(e) => { setPicked(e.target.value); setStaged(null); }}>
            {files.map((f) => (
              <option key={f.name} value={f.name}>{new Date(f.modifiedAt).toLocaleString()} · {size(f.byteSize)} · {f.encrypted ? 'protected' : 'not protected'}</option>
            ))}
          </select>
        </div>
      ) : files && configured ? (
        <p className="text-sm text-muted-foreground">Your backup folder is empty. Choose a backup file from this computer instead.</p>
      ) : null}

      {needsPassword || (!chosen && !staged) ? (
        <div>
          <label className="mb-1 block text-sm" htmlFor="restore-password">Backup password</label>
          <Input id="restore-password" type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)}
                 placeholder={needsPassword ? 'The password you set for your backups' : 'Only if the backup is protected'} />
        </div>
      ) : null}

      {staged ? (
        <div className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p>Made by Josi {staged.manifest.josiVersion} on {new Date(staged.manifest.createdAt).toLocaleString()}.</p>
          {staged.refusals.map((w) => <p key={w} className="text-red-600">{w}</p>)}
          {staged.warnings.map((w) => <p key={w} className="text-muted-foreground">{w}</p>)}
          <div className="flex gap-2">
            <Button type="button" disabled={busy || staged.refusals.length > 0} onClick={() => void confirmStaged()}>{busy ? 'Restoring…' : 'Restore this backup'}</Button>
            <Button type="button" variant="secondary" disabled={busy} onClick={() => setStaged(null)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {chosen ? (
            <Button type="button" disabled={busy || (needsPassword && password.length < 1)} onClick={() => void restoreFromFolder()}>
              {busy ? 'Restoring…' : 'Restore this backup'}
            </Button>
          ) : null}
          <Button type="button" variant="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>Choose a file from this computer</Button>
          {onCancel ? <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Back</Button> : null}
          <input ref={fileInput} type="file" className="hidden" accept=".josi-backup,.zip,.gz,application/zip"
                 onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void chooseUpload(f); }} />
        </div>
      )}
    </div>
  );
}
