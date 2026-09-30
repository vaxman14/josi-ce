import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { fetchVoiceAudio } from '@/lib/voiceAudio';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

type Provider = 'whatsapp' | 'slack' | 'twilio';
interface Channel { provider: Provider; enabled: boolean; configured: boolean; riskAcknowledged: boolean; probedAt: string | null; probeOk: boolean | null; probeError: string | null }
interface VoiceSettings { voice: string; model: string; threshold: number; silenceMs: number; speed: number; device: 'cpu' | 'cuda' }
interface VoiceStatus { healthy: boolean; verified: boolean; phase: string; settings?: VoiceSettings }
const label = (p: Provider) => p === 'whatsapp' ? 'WhatsApp' : p === 'slack' ? 'Slack' : 'Twilio SMS + calling';

export function AdminChannels() {
  const [channels, setChannels] = useState<Channel[]>([]); const [selected, setSelected] = useState<Provider>('whatsapp');
  const [form, setForm] = useState<Record<string,string>>({}); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<VoiceStatus>(); const [previewing, setPreviewing] = useState(false);
  const preview = useRef<{ context?: AudioContext; abort?: AbortController }>({});
  const load = useCallback(async () => setChannels((await api.get<{ channels: Channel[] }>('/admin/channels')).channels), []);
  const loadVoice = useCallback(async () => {
    const value = await api.get<VoiceStatus>('/admin/voice-box'); setVoiceStatus(value); return value;
  }, []);
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load channels')); }, [load]);
  useEffect(() => {
    if (selected !== 'twilio') return;
    void loadVoice().catch((e) => setError(e instanceof Error ? e.message : 'Could not load Voice Box'));
    const timer = setInterval(() => void loadVoice().catch(() => undefined), 3000);
    return () => clearInterval(timer);
  }, [selected, loadVoice]);
  useEffect(() => () => { preview.current.abort?.abort(); void preview.current.context?.close(); }, []);
  const current = channels.find((c) => c.provider === selected);
  const fields = selected === 'whatsapp' ? [['appSecret','Meta app secret'],['accessToken','Permanent access token'],['phoneNumberId','Phone number ID'],['webhookSecret','Webhook verify token (enter the same value in Meta)']]
    : selected === 'slack' ? [['signingSecret','Signing secret'],['botToken','Bot token']]
    : [['accountSid','Account SID'],['authToken','Auth Token'],['messagingServiceSid','Messaging Service SID'],['phoneNumber','Twilio phone number (E.164)']];
  async function run(fn: () => Promise<unknown>, ok: string) { setBusy(true); setError(''); setNotice(''); try { await fn(); setNotice(ok); await load(); } catch(e) { setError(e instanceof Error ? e.message : 'That did not work'); } finally { setBusy(false); } }
  async function playVoicePreview() {
    if (previewing) return;
    setPreviewing(true); setError('');
    const context = new AudioContext(); const abort = new AbortController(); preview.current = { context, abort };
    try {
      await context.resume();
      const data = await fetchVoiceAudio('/admin/channels/twilio/voice-preview', {}, abort.signal);
      const buffer = await context.decodeAudioData(data); const source = context.createBufferSource(); source.buffer = buffer; source.connect(context.destination);
      const done = new Promise<void>((resolve) => { source.onended = () => resolve(); }); source.start(); await done;
    } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : 'The preview could not be played'); }
    finally { if (context.state !== 'closed') await context.close(); setPreviewing(false); }
  }
  return <div className="mx-auto max-w-3xl space-y-4"><div><h1 className="text-xl font-semibold">Messaging channels</h1><p className="text-sm text-muted-foreground">Credentials are encrypted and never returned after saving.</p></div>{error ? <ErrorNote>{error}</ErrorNote> : null}{notice ? <p className="text-sm text-emerald-300">{notice}</p> : null}
    <div className="flex flex-wrap gap-2">
      <Link className="inline-flex min-h-11 items-center justify-center rounded-md bg-secondary px-4 text-sm font-medium hover:bg-secondary/80" to="/admin/telegram">Telegram</Link>
      {(['whatsapp','slack','twilio'] as Provider[]).map((p) => <Button key={p} aria-pressed={selected === p} variant={selected === p ? 'primary' : 'secondary'} onClick={() => { setSelected(p); setForm({}); }}>{label(p)}</Button>)}
    </div>
    <Card><CardTitle>{label(selected)}</CardTitle><div className="mb-3 flex gap-2"><Badge tone={current?.enabled ? 'ok' : 'muted'}>{current?.enabled ? 'On' : 'Off'}</Badge><Badge tone={current?.configured ? 'ok' : 'muted'}>{current?.configured ? 'Configured' : 'Not configured'}</Badge>{current?.probeOk === false ? <Badge tone="danger">Test failed</Badge> : null}</div>
      <div className="space-y-3">{fields.map(([name, title]) => <label key={name} className="block text-sm font-medium">{title}<Input type={name.toLowerCase().includes('url') || name === 'account' || name === 'phoneNumberId' ? 'text' : 'password'} autoComplete="off" value={form[name] ?? ''} onChange={(e) => setForm({...form,[name]:e.target.value})}/></label>)}
      <div className="flex flex-wrap gap-2"><Button disabled={busy || fields.some(([n]) => !form[n]?.trim())} onClick={() => void run(() => api.post(`/admin/channels/${selected}/config`, form), 'Configuration saved. Test it before enabling.')}>Save</Button><Button variant="secondary" disabled={busy || !current?.configured} onClick={() => void run(() => api.post(`/admin/channels/${selected}/probe`), 'Provider connection tested.')}>Test</Button><Button disabled={busy || !current?.probeOk} onClick={() => void run(() => api.post(`/admin/channels/${selected}/enabled`, {enabled:!current?.enabled}), current?.enabled ? 'Channel turned off.' : 'Channel turned on.')}>{current?.enabled ? 'Turn off' : 'Turn on'}</Button>{selected === 'twilio' ? <Button variant="secondary" disabled={busy || !current?.enabled} onClick={() => void run(() => api.post('/admin/channels/twilio/register-webhooks'), 'SMS and voice webhooks registered on the Twilio number.')}>Register webhooks</Button> : null}</div></div>
    </Card>
    {selected === 'twilio' ? <Card><CardTitle>Call voice</CardTitle>
      {!voiceStatus?.verified ? <p className="text-sm text-muted-foreground">Install and verify <Link className="underline" to="/admin/voice-box">Voice Box</Link> before previewing calls.</p> : <div className="space-y-3">
        <p className="font-medium">The Neighbor</p>
        <p className="text-sm text-muted-foreground">Josi’s fixed call voice. Previewing uses the exact greeting and corrected 8 kHz phone conversion without placing a call.</p>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={busy || previewing || !voiceStatus.healthy || voiceStatus.phase !== 'ready'} onClick={() => void playVoicePreview()}>{previewing ? 'Playing phone preview…' : 'Preview call greeting'}</Button></div>
        <p role="status" className="text-sm">{voiceStatus.phase === 'working' ? 'Applying the voice and checking local speech models…' : voiceStatus.healthy ? 'Voice Box is ready.' : 'Voice Box is not ready.'}</p>
      </div>}
    </Card> : null}
    <Card><CardTitle>Webhook URLs</CardTitle><p className="text-sm text-muted-foreground">{selected === 'twilio' ? <>Josi registers <code>/channels/twilio/webhook</code> for SMS and <code>/channels/twilio/voice</code> for calls. Voice requires a healthy local Voice Box.</> : <>Configure the provider to deliver to <code>/channels/{selected}/webhook</code> on this installation. WhatsApp uses the same URL for verification.</>}</p></Card></div>;
}
