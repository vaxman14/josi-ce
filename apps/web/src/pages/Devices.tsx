// Pairing and revoking devices. Anyone signed in can do this for their own: a
// pairing opens the encrypted connection for one device and nothing else, and
// the person still signs in to Josi on it.
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote } from '@/components/ui';
import { RelayPrivacy } from '@/components/RelayPrivacy';

interface Device { id: string; name: string; platform: string; pairedAt: string; lastSeenAt: string | null; revokedAt: string | null }
interface Pairing { code: string; link: string | null; qr: string | null; expiresAt: string }

const when = (value: string | null) => value ? new Date(value).toLocaleString() : 'Not yet';

export function Devices() {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [connected, setConnected] = useState<string[]>([]);
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const r = await api.get<{ devices: Device[]; connected: string[] }>('/hey-josi/devices');
      setDevices(r.devices); setConnected(r.connected);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not load your devices.'); }
  }
  useEffect(() => { void load(); }, []);

  async function pair() {
    setBusy(true); setError('');
    try { setPairing(await api.post<Pairing>('/hey-josi/pairing')); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not make a pairing code.'); }
    finally { setBusy(false); }
  }

  async function revoke(device: Device) {
    if (!window.confirm(`Remove ${device.name}? It will be disconnected now and can't reconnect without pairing again.`)) return;
    setError('');
    try { await api.del(`/hey-josi/devices/${device.id}`); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not remove that device.'); }
  }

  const live = devices?.filter(d => !d.revokedAt) ?? [];
  return (
    <div className="page">
      <h1 className="page-title">Devices</h1>
      <p className="text-sm text-muted-foreground">Phones, computers and browsers that can reach this server from anywhere. Each one has its own key, and you still sign in on it.</p>
      {error && <ErrorNote>{error}</ErrorNote>}

      <Card>
        <CardTitle>Add a device</CardTitle>
        {pairing ? (
          <div className="space-y-3">
            {pairing.qr && <img src={pairing.qr} alt="Pairing QR code" width={220} height={220} />}
            <p className="text-sm">Scan this with the device, or type this code into the Josi app or at your address:</p>
            <p className="font-mono text-sm break-all">{pairing.code}</p>
            <p className="text-sm text-muted-foreground">Works once, until {new Date(pairing.expiresAt).toLocaleTimeString()}.</p>
            <Button onClick={() => { setPairing(null); void load(); }}>Done</Button>
          </div>
        ) : <Button onClick={() => void pair()} disabled={busy}>{busy ? 'Making a code…' : 'Make a pairing code'}</Button>}
      </Card>

      <Card>
        <CardTitle>Your devices</CardTitle>
        {devices === null ? <p className="text-sm text-muted-foreground">Loading…</p>
          : !live.length ? <p className="text-sm text-muted-foreground">Nothing paired yet.</p>
          : <ul className="space-y-3">{live.map(device => (
              <li key={device.id} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">{device.name}</p>
                  <p className="text-sm text-muted-foreground">{connected.includes(device.id) ? 'Connected now' : `Last seen: ${when(device.lastSeenAt)}`}</p>
                </div>
                <Button onClick={() => void revoke(device)}>Remove</Button>
              </li>
            ))}</ul>}
      </Card>

      <RelayPrivacy />
    </div>
  );
}
