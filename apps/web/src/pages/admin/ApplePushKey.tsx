import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface Status {
  configured: boolean; keyId: string | null; teamId: string | null; checked: 'accepted' | 'unknown' | null;
  updatedAt: string | null; defaultTeamId: string; bundleId: string;
}

/** Where the owner pastes the Apple push key. Without it iPhones get no notifications. */
export function ApplePushKeyCard() {
  const [status, setStatus] = useState<Status>();
  const [open, setOpen] = useState(false);
  const [keyId, setKeyId] = useState('');
  const [teamId, setTeamId] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { api.get<Status>('/admin/push/apple').then(setStatus).catch(() => undefined); }, []);
  if (!status) return null;
  async function save() {
    setBusy(true); setError('');
    try {
      setStatus(await api.put<Status>('/admin/push/apple', { key_id: keyId, team_id: teamId || status!.defaultTeamId, private_key: privateKey }));
      setOpen(false); setKeyId(''); setPrivateKey('');
    } catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { await api.del('/admin/push/apple'); setStatus(await api.get<Status>('/admin/push/apple')); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  }
  return <Card>
    <CardTitle>iPhone notifications</CardTitle>
    <div className="mb-3 mt-2 flex flex-wrap gap-2">
      <Badge tone={status.configured ? 'ok' : 'muted'}>{status.configured ? `Key ${status.keyId} saved` : 'No key yet'}</Badge>
      {status.configured ? <Badge tone={status.checked === 'accepted' ? 'ok' : 'muted'}>{status.checked === 'accepted' ? 'Apple accepted it' : 'Not checked with Apple yet'}</Badge> : null}
    </div>
    <p className="text-sm text-muted-foreground">
      {status.configured
        ? 'Josi sends iPhone notifications straight to Apple with this key. The key is sealed in the Vault and is never shown again.'
        : 'iPhones get no notifications until an Apple push key is saved here. Make one in the Apple Developer portal: Certificates, IDs & Profiles, then Keys, with Apple Push Notifications service turned on. You get a .p8 file and a Key ID.'}
    </p>
    {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    {open ? <div className="mt-3 grid gap-3">
      <label className="grid gap-1 text-sm">Key ID<Input value={keyId} onChange={(e) => setKeyId(e.target.value)} placeholder="10 letters and digits" autoComplete="off" /></label>
      <label className="grid gap-1 text-sm">Team ID<Input value={teamId} onChange={(e) => setTeamId(e.target.value)} placeholder={status.defaultTeamId} autoComplete="off" /></label>
      <label className="grid gap-1 text-sm">The .p8 file, pasted whole
        <textarea className="min-h-32 rounded-md border border-input bg-background p-2 font-mono text-xs" value={privateKey} onChange={(e) => setPrivateKey(e.target.value)}
          placeholder="-----BEGIN PRIVATE KEY-----" spellCheck={false} autoComplete="off" />
      </label>
      <div className="flex gap-2"><Button onClick={() => void save()} disabled={busy || !keyId || !privateKey}>{busy ? 'Checking with Apple…' : 'Check and save'}</Button>
        <Button variant="ghost" onClick={() => { setOpen(false); setError(''); }} disabled={busy}>Cancel</Button></div>
    </div> : <div className="mt-3 flex gap-2">
      <Button onClick={() => setOpen(true)}>{status.configured ? 'Replace key' : 'Add key'}</Button>
      {status.configured ? <Button variant="ghost" onClick={() => void remove()} disabled={busy}>Remove</Button> : null}
    </div>}
  </Card>;
}
