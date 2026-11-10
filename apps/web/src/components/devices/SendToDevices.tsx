// "Send to my devices": send a file to another of my devices or to another
// person, and receive what is waiting for this browser.
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote } from '@/components/ui';
import {
  acceptTransfer, browserName, declineTransfer, downloadTransfer, formatSize, loadInbox, loadTargets, markReceived,
  registerThisDevice, sendFile, targetLabel, thisDeviceId, type Inbox, type Targets, type Transfer,
} from '@/lib/devices';

const selectClass = 'min-h-11 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm';
const fail = (e: unknown, fallback: string) => e instanceof ApiError || e instanceof Error ? e.message : fallback;
const STATES: Record<string, string> = {
  offered: 'Waiting for them to accept', accepted: 'Waiting to be received', delivered: 'Received',
  declined: 'Declined', expired: 'Expired after 7 days',
};

export function SendToDevices() {
  const [deviceId] = useState(thisDeviceId);
  const [registered, setRegistered] = useState(false);
  const [targets, setTargets] = useState<Targets | null>(null);
  const [inbox, setInbox] = useState<Inbox>({ transfers: [], sent: [] });
  const [target, setTarget] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState('');
  const chooser = useRef<HTMLInputElement>(null);

  const refreshInbox = useCallback(async () => {
    try { setInbox(await loadInbox(deviceId)); } catch { /* the next poll tries again */ }
  }, [deviceId]);
  const refreshTargets = useCallback(async () => {
    try { setTargets(await loadTargets(deviceId)); } catch (e) { setError(fail(e, 'Could not load where files can go.')); }
  }, [deviceId]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try { await registerThisDevice(deviceId, browserName(navigator.userAgent)); }
      catch (e) { if (alive) setError(fail(e, 'Could not register this browser.')); return; }
      if (!alive) return;
      setRegistered(true);
      await Promise.all([refreshTargets(), refreshInbox()]);
    })();
    return () => { alive = false; };
  }, [deviceId, refreshTargets, refreshInbox]);

  useEffect(() => {
    if (!registered) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refreshInbox(); }, 15_000);
    return () => window.clearInterval(timer);
  }, [registered, refreshInbox]);

  async function send() {
    if (!file || !target) return;
    const split = target.indexOf(':');
    const kind = target.slice(0, split), id = target.slice(split + 1);
    if (targets && file.size > targets.maxBytes) { setError(`That file is larger than ${formatSize(targets.maxBytes)}, the most Josi sends between devices.`); return; }
    setBusy('send'); setError(''); setNote('');
    try {
      const r = await sendFile(file, kind === 'device' ? { device: id } : { person: id }, deviceId);
      setNote(r.state === 'offered' ? 'Offered. They will see it and can accept it.' : 'Sent. It will arrive the next time that device checks.');
      setFile(null); if (chooser.current) chooser.current.value = '';
      await refreshInbox();
    } catch (e) { setError(fail(e, 'Could not send that file.')); }
    finally { setBusy(''); }
  }

  async function run(id: string, work: () => Promise<unknown>, failure: string) {
    setBusy(id); setError(''); setNote('');
    try { await work(); } catch (e) { setError(fail(e, failure)); }
    finally { setBusy(''); await refreshInbox(); }
  }
  const accept = (t: Transfer) => run(t.id, () => acceptTransfer(t.id, deviceId), 'Could not accept that file.');
  const decline = (t: Transfer) => run(t.id, () => declineTransfer(t.id), 'Could not decline that file.');
  const download = (t: Transfer) => run(t.id, async () => {
    await downloadTransfer(t, deviceId);
    // The save has started; tell the server so it clears its copy.
    await markReceived(t.id, deviceId).catch(() => undefined);
  }, 'Could not download that file.');

  const offers = inbox.transfers.filter(t => t.state === 'offered');
  const accepted = inbox.transfers.filter(t => t.state === 'accepted');

  return (
    <Card>
      <CardTitle>Send to my devices</CardTitle>
      <p className="mb-3 text-sm text-muted-foreground">Send a file (up to {formatSize(targets?.maxBytes ?? 25 * 1024 * 1024)}) to another of your devices, or offer it to another person here. Files are kept only until they arrive, are declined, or 7 days pass.</p>
      {error && <ErrorNote>{error}</ErrorNote>}
      {note && <p className="mb-2 text-sm text-muted-foreground" role="status">{note}</p>}

      <div className="space-y-3">
        <label className="block text-sm">File
          <input ref={chooser} type="file" className="mt-1 block w-full text-sm" onChange={e => setFile(e.target.files?.[0] ?? null)} />
        </label>
        <label className="block text-sm">Send to
          <select className={`mt-1 ${selectClass}`} value={target} onChange={e => setTarget(e.target.value)}>
            <option value="">Choose where it goes</option>
            {targets?.devices.length ? <optgroup label="My devices">
              {targets.devices.map(d => <option key={d.id} value={`device:${d.id}`}>{targetLabel(d)}</option>)}
            </optgroup> : null}
            {targets?.people.length ? <optgroup label="People">
              {targets.people.map(p => <option key={p.id} value={`person:${p.id}`}>{p.name}</option>)}
            </optgroup> : null}
          </select>
        </label>
        {targets && !targets.devices.length && !targets.people.length
          ? <p className="text-sm text-muted-foreground">No other devices or people yet. Sign in to Josi on another device, or add someone, and they will show up here.</p> : null}
        <Button onClick={() => void send()} disabled={!file || !target || busy === 'send' || !registered}>{busy === 'send' ? 'Sending…' : 'Send'}</Button>
      </div>

      {offers.length || accepted.length ? <div className="mt-5 border-t border-border pt-3">
        <p className="mb-2 text-sm font-medium">Waiting for this browser</p>
        <ul className="space-y-3">
          {offers.map(t => <li key={t.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0"><p className="truncate text-sm font-medium">{t.name}</p>
              <p className="text-sm text-muted-foreground">From {t.from} · {formatSize(t.size)}</p></div>
            <div className="flex shrink-0 gap-2">
              <Button onClick={() => void accept(t)} disabled={busy === t.id}>Accept</Button>
              <Button onClick={() => void decline(t)} disabled={busy === t.id}>Decline</Button>
            </div>
          </li>)}
          {accepted.map(t => <li key={t.id} className="flex items-center justify-between gap-3">
            <div className="min-w-0"><p className="truncate text-sm font-medium">{t.name}</p>
              <p className="text-sm text-muted-foreground">{t.own ? `From ${t.fromDevice ?? 'your other device'}` : `From ${t.from}`} · {formatSize(t.size)}</p></div>
            <Button onClick={() => void download(t)} disabled={busy === t.id}>{busy === t.id ? 'Downloading…' : 'Download'}</Button>
          </li>)}
        </ul>
      </div> : null}

      {inbox.sent.length ? <div className="mt-5 border-t border-border pt-3">
        <p className="mb-2 text-sm font-medium">Sent from this browser</p>
        <ul className="space-y-2">
          {inbox.sent.map(t => <li key={t.id} className="text-sm">
            <span className="font-medium">{t.name}</span>
            <span className="text-muted-foreground"> to {t.own ? (t.toDevice ?? 'your device') : t.to} · {STATES[t.state] ?? t.state}</span>
          </li>)}
        </ul>
      </div> : null}
    </Card>
  );
}
