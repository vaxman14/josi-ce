import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { RelayPrivacy } from '@/components/RelayPrivacy';

interface Usage { allowance: number; topUps: number; spent: number; reserved: number; remaining: number; accountCap: number | null; periodEnd: string | null }
interface Status {
  linked: boolean; ownRelay: boolean; plan: 'free' | 'connect' | 'connect_ai'; address: string | null;
  relay: { enabled: boolean; state: string; error: string | null }; lan: { enabled: boolean; addresses: string[] };
  keyStore: string; keyOverlapUntil: string | null; lastSyncAt: string | null; lastSyncError: string | null;
  usage: Usage | null; aiReady: boolean;
}

const PLAN = { free: 'Free', connect: 'Connect', connect_ai: 'Connect + AI' };
const STORE: Record<string, string> = {
  'macos-keychain': 'macOS Keychain', 'windows-credential-manager': 'Windows Credential Manager', 'linux-secret-service': 'Secret Service',
  file: 'A private file on this server, because no credential store is available',
};
const dollars = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

export function AdminHeyJosi() {
  const [status, setStatus] = useState<Status | null>(null);
  const [code, setCode] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => { try { setStatus(await api.get<Status>('/admin/hey-josi')); } catch (e) { setError(e instanceof Error ? e.message : 'Could not load this page.'); } };
  useEffect(() => { void load(); }, []);

  async function act(work: () => Promise<unknown>, done = '') {
    setBusy(true); setError(''); setNote('');
    try { await work(); setPassword(''); setNote(done); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'That did not work.'); }
    finally { setBusy(false); }
  }

  const passwordField = <Input type="password" autoComplete="current-password" placeholder="Your Josi password" value={password} onChange={e => setPassword(e.target.value)} />;
  const attached = status && (status.linked || status.ownRelay);

  return (
    <div className="page">
      <h1 className="page-title">Hey Josi</h1>
      <p className="text-sm text-muted-foreground">Reach this server from anywhere at your own address, with no port forwarding. Optional: Josi CE works fully without it.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && <p className="text-sm">{note}</p>}

      {status && !attached && (
        <>
          <Card>
            <CardTitle>Link your account</CardTitle>
            <p className="text-sm text-muted-foreground">Sign up at heyjosi.com and copy the code from your account page.</p>
            <div className="space-y-2">
              <Input placeholder="Link code" autoComplete="off" value={code} onChange={e => setCode(e.target.value)} />
              {passwordField}
              <Button disabled={busy || !code || !password} onClick={() => void act(() => api.post('/admin/hey-josi/link', { code, password }), 'Linked.')}>Link this server</Button>
            </div>
          </Card>
          <Card>
            <CardTitle>Use your own relay</CardTitle>
            <p className="text-sm text-muted-foreground">No account needed. See the self-hosted relay guide in the help pages.</p>
            <div className="space-y-2">
              <Input placeholder="https://relay.example.com" value={relayUrl} onChange={e => setRelayUrl(e.target.value)} />
              {passwordField}
              <Button disabled={busy || !relayUrl || !password} onClick={() => void act(() => api.post('/admin/hey-josi/own-relay', { relayUrl, password }), 'Connected to your relay.')}>Use this relay</Button>
            </div>
          </Card>
        </>
      )}

      {status && attached && (
        <>
          <Card>
            <CardTitle>{status.address ?? 'Relay'}</CardTitle>
            <dl className="text-sm space-y-1">
              {status.linked && <div>Plan: {PLAN[status.plan]}</div>}
              <div>Relay: {status.relay.state === 'online' ? 'Connected' : status.relay.enabled ? 'Not connected right now' : 'Off'}</div>
              {status.relay.error && <div>Last problem: {status.relay.error}</div>}
              {status.lastSyncError && <div>Last sync problem: {status.lastSyncError}</div>}
              <div>On your network: {status.lan.enabled ? (status.lan.addresses.length ? 'Devices connect directly when they can' : 'Waiting for a network address') : 'Off'}</div>
            </dl>
            <div className="mt-3 flex gap-2">
              <Button disabled={busy} onClick={() => void act(() => api.put('/admin/hey-josi/lan', { enabled: !status.lan.enabled }))}>{status.lan.enabled ? 'Turn off direct connections' : 'Turn on direct connections'}</Button>
              {status.linked && <Button disabled={busy} onClick={() => void act(() => api.post('/admin/hey-josi/sync'), 'Up to date.')}>Refresh</Button>}
            </div>
          </Card>

          {status.usage && (status.plan === 'connect_ai' || status.aiReady) && (
            <Card>
              <CardTitle>AI allowance</CardTitle>
              <p className="text-sm">{dollars(status.usage.remaining)} left of {dollars(status.usage.allowance + status.usage.topUps)}</p>
              {status.usage.periodEnd && <p className="text-sm text-muted-foreground">Resets {new Date(status.usage.periodEnd).toLocaleDateString()}. Top-ups carry over.</p>}
              <p className="text-sm text-muted-foreground">When it runs out, Josi stops AI replies and says why. Add a top-up on your account page.</p>
              {status.aiReady && <Button disabled={busy} onClick={() => void act(() => api.post('/admin/hey-josi/ai/use'), 'Saved. Finish on the Model page, where Josi checks it works.')}>Use Hey Josi AI</Button>}
            </Card>
          )}

          <Card>
            <CardTitle>Server key</CardTitle>
            <p className="text-sm">Stored in: {STORE[status.keyStore] ?? status.keyStore}</p>
            {status.keyOverlapUntil && <p className="text-sm text-muted-foreground">The previous key still works until {new Date(status.keyOverlapUntil).toLocaleDateString()}.</p>}
            <div className="space-y-2 mt-2">
              {passwordField}
              <div className="flex gap-2">
                <Button disabled={busy || !password} onClick={() => void act(() => api.post('/admin/hey-josi/keys/rotate', { password }), 'New key in place. Devices pick it up on their own.')}>Change key</Button>
                <Button disabled={busy || !password} onClick={() => { if (window.confirm('Destroy the current key now? Every device disconnects, and any that are offline must pair again.')) void act(() => api.post('/admin/hey-josi/keys/rotate', { password, immediate: true }), 'Old key destroyed.'); }}>Change now, key may be stolen</Button>
              </div>
            </div>
          </Card>

          <Card>
            <CardTitle>{status.linked ? 'Unlink this server' : 'Stop using this relay'}</CardTitle>
            <p className="text-sm text-muted-foreground">Your address stops working. Everything on this server stays.</p>
            <div className="space-y-2">
              {passwordField}
              <Button disabled={busy || !password} onClick={() => void act(() => api.post('/admin/hey-josi/unlink', { password }), 'Done.')}>{status.linked ? 'Unlink' : 'Disconnect'}</Button>
            </div>
          </Card>
        </>
      )}

      <RelayPrivacy />
    </div>
  );
}
