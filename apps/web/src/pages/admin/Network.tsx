import { useEffect, useId, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface Tailscale {
  installed: boolean; running: boolean; state: string | null; name: string | null; ips: string[];
  tailnet: string | null; loginName: string | null; version: string | null; error: string | null;
}
interface Network {
  publicUrl: string; mode: 'local' | 'lan' | 'tailscale' | 'public'; port: number; editable: boolean;
  configuredUrl: string | null; restartNeeded: boolean; lan: Array<{ name: string; address: string }>;
  certificate: { fingerprint: string } | null; tailscale: Tailscale; tailscaleUrl: string | null;
  https?: boolean; apiPort?: number; proxyManaged?: boolean;
  /** Older servers leave this out; they are Windows or Mac desktops. */
  server?: { platform: string; maintenanceHelper: boolean };
}

const modeText = (mode: Network['mode'], machine: string): string => ({
  local: `Only ${machine} reaches Josi.`,
  lan: `${machine.charAt(0).toUpperCase()}${machine.slice(1)} and your network, over HTTPS with Josi's own certificate.`,
  tailscale: "Your devices over Tailscale, over HTTPS with Josi's own certificate.",
  public: 'A public domain, served through your tunnel or reverse proxy.',
})[mode];

export function AdminNetwork() {
  const passwordId = useId();
  const helpId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [launch, setLaunch] = useState<{ url: string; code: string } | null>(null);
  const [network, setNetwork] = useState<Network | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    try { setNetwork(await api.get<Network>('/admin/network')); }
    catch { setNetwork(null); }
  }
  useEffect(() => { void load(); }, []);

  async function useTailscale() {
    if (!network?.tailscaleUrl) return;
    setSaving(true); setError(''); setNote('');
    try {
      const r = await api.put<{ note: string }>('/admin/network', { publicUrl: network.tailscaleUrl });
      setNote(r.note); await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not change the address.');
    } finally { setSaving(false); }
  }

  async function open() {
    if (!password) { setError('Enter your current Josi administrator password.'); return; }
    setBusy(true); setError(''); setLaunch(null);
    try {
      const value = await api.post<{ url: string; code: string }>('/admin/maintenance/network/launch', { password, host: window.location.hostname });
      setPassword(''); setLaunch(value);
      window.open(value.url, 'josi-maintenance', 'noopener,noreferrer');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not start protected maintenance. Try again.');
    } finally { setBusy(false); }
  }

  const ts = network?.tailscale;
  const linuxServer = network?.server?.platform === 'linux';
  const machine = linuxServer ? 'this server' : 'this PC';
  // The LAN addresses answer on the scheme the server really uses: https when
  // its address is https (Josi's certificate or the bundled proxy), else plain
  // http straight to the server's own port.
  const lanScheme = network?.https === false ? 'http' : 'https';
  const lanPort = network ? (network.https === false && !network.proxyManaged ? network.apiPort ?? network.port : network.port) : 0;
  // A Linux server has no protected maintenance controller: its installer
  // chooses the address, so say that instead of offering a controller that
  // answers with an error.
  const noController = linuxServer && network?.server?.maintenanceHelper === false;
  const tailscaleSet = network?.mode === 'tailscale' && network.publicUrl === network.tailscaleUrl;

  return <div className="page">
    <div><h1 className="page-title">Network &amp; address</h1><p className="text-sm text-muted-foreground">Where this server answers, and how other devices reach it.</p></div>
    {error ? <ErrorNote>{error}</ErrorNote> : null}

    {network ? <Card data-testid="josi.network.addresses">
      <CardTitle>Addresses</CardTitle>
      <p className="text-sm font-medium">Public address</p>
      <p className="font-mono text-sm" data-testid="josi.network.publicUrl">{network.publicUrl}</p>
      <p className="text-xs text-muted-foreground">{modeText(network.mode, machine)}</p>
      {network.restartNeeded ? <p className="mt-2 text-sm text-warning">The saved address ({network.configuredUrl}) differs from the running one. Restart the server to apply it.</p> : null}
      {network.lan.length ? <div className="mt-3">
        <p className="text-sm font-medium">{linuxServer ? 'This server' : 'This PC'} on the network</p>
        <p className="text-xs text-muted-foreground">Other devices reach this server at one of these once the public address is set to it.</p>
        <ul className="mt-1 font-mono text-sm">{network.lan.map(a => <li key={a.name}><span className="text-muted-foreground">{a.name}: </span>{lanScheme}://{a.address}:{lanPort}</li>)}</ul>
      </div> : null}
      {network.certificate ? <p className="mt-3 text-xs text-muted-foreground">Certificate fingerprint: <span className="font-mono">{network.certificate.fingerprint}</span></p> : null}
    </Card> : null}

    {network ? <Card data-testid="josi.network.tailscale">
      <CardTitle>Tailscale</CardTitle>
      <p className="mb-2 text-sm text-muted-foreground">Reach Josi from your phone or another PC anywhere, with no public domain and no port forwarding. Install Tailscale on {machine} and on each device, sign them all in to the same Tailscale account, and use this server's Tailscale address.</p>
      {!ts?.installed ? <p className="text-sm">Tailscale is not installed on {machine}. Get it from <a className="underline" href="https://tailscale.com/download" target="_blank" rel="noreferrer">tailscale.com/download</a>, sign in, then reload this page.</p>
        : !ts.running ? <p className="text-sm">{ts.error ?? `Tailscale is installed but not connected (${ts.state ?? 'stopped'}). Open Tailscale, sign in, then reload this page.`}</p>
        : <div>
          <p className="text-sm">Connected as {ts.loginName ?? 'your account'}{ts.tailnet ? ` on ${ts.tailnet}` : ''}.</p>
          <p className="mt-2 text-sm font-medium">This server's Tailscale address</p>
          <p className="font-mono text-sm" data-testid="josi.network.tailscaleUrl">{network.tailscaleUrl}</p>
          {ts.ips.length ? <p className="text-xs text-muted-foreground">Tailscale IP: {ts.ips.join(', ')}</p> : null}
          {tailscaleSet
            ? <p className="mt-2 text-sm">This is the public address now. On your phone, install Tailscale, sign in to the same account, and give the Josi app this address. The app shows the certificate fingerprint once; compare it with the one above.</p>
            : <div className="mt-3">
              <Button data-testid="josi.network.useTailscale" disabled={saving || !network.editable} onClick={() => void useTailscale()}>{saving ? 'Saving…' : 'Use the Tailscale address'}</Button>
              <p className="mt-1 text-xs text-muted-foreground">Sets the public address to the Tailscale name on the current port. Restart the server afterwards.{network.editable ? '' : ' This server takes its address from where it is started, so set APP_URL there.'}</p>
            </div>}
          {note ? <p className="mt-2 text-sm" aria-live="polite">{note}</p> : null}
        </div>}
    </Card> : null}

    {noController ? <Card data-testid="josi.network.linuxAddress">
      <CardTitle>Changing the address</CardTitle>
      <p className="text-sm text-muted-foreground">On this Linux server the address is chosen by the installer. To change it, run the install command again on the server (<code className="font-mono">curl -fsSL &lt;install address&gt;/linux | sudo bash</code>). It prints the current address and lets you keep it or pick a new one: LAN only over plain http, or a public domain over https. Your data and settings stay as they are.</p>
      <p className="mt-2 text-sm text-muted-foreground">You can also ask Josi in chat what her address is.</p>
    </Card> : <Card>
      <CardTitle>Open protected maintenance</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">Change LAN, public-domain, reverse-proxy, and port settings without reinstalling Josi. Josi briefly opens a separate local controller because this page becomes unavailable while its address changes. The controller previews the change, verifies health at the new address, and restores the previous configuration if it fails.</p>
      <label className="mb-1 block text-sm font-medium" htmlFor={passwordId}>Admin password</label>
      <Input id={passwordId} type="password" autoComplete="current-password" placeholder="Enter your current admin password" aria-describedby={helpId} value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && !busy) void open(); }} />
      <p id={helpId} className="mt-1 text-xs text-muted-foreground">Enter your current Josi administrator password to open the temporary protected network-change controller. It is submitted only for this reauthentication and is never saved.</p>
      <Button className="mt-3" disabled={busy || !password} onClick={() => void open()}>{busy ? 'Starting protected controller…' : 'Continue'}</Button>
      {launch ? <div className="mt-4 rounded-md border border-border p-3" aria-live="polite"><p className="text-sm">Protected maintenance is ready. If the new tab was blocked, open <a className="underline" href={launch.url} target="_blank" rel="noreferrer">{launch.url}</a>.</p><p className="mt-1 font-mono text-lg">Setup code: {launch.code}</p><p className="text-xs text-muted-foreground">The code works once and expires with the maintenance session.</p></div> : null}
    </Card>}
  </div>;
}
