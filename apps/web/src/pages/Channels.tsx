import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';

type Provider = 'whatsapp' | 'slack' | 'signal';
interface Channel { provider: Provider; enabled: boolean; configured: boolean; probeOk: boolean | null }
interface Link { id: string; provider: Provider; status: string; linkedAt: string; lastInboundAt: string | null }

export function Channels() {
  const [channels, setChannels] = useState<Channel[]>([]); const [links, setLinks] = useState<Link[]>([]);
  const [instruction, setInstruction] = useState(''); const [error, setError] = useState('');
  const load = useCallback(async () => { const r = await api.get<{ channels: Channel[]; links: Link[] }>('/channels'); setChannels(r.channels); setLinks(r.links); }, []);
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load channels')); }, [load]);
  async function mint(provider: Provider) { try { setError(''); const r = await api.post<{ instruction: string }>(`/channels/${provider}/link-code`); setInstruction(r.instruction); } catch (e) { setError(e instanceof Error ? e.message : 'Could not create a link code'); } }
  return <div className="mx-auto max-w-3xl space-y-4">
    <div><h1 className="text-xl font-semibold">Messaging channels</h1><p className="text-sm text-muted-foreground">Talk to the same Josi conversation from another app.</p></div>
    {error ? <ErrorNote>{error}</ErrorNote> : null}{instruction ? <Card><CardTitle>One-time link code</CardTitle><p className="break-all text-sm">{instruction}</p><p className="mt-2 text-xs text-muted-foreground">Expires in 10 minutes and works once.</p></Card> : null}
    <div className="grid gap-3 sm:grid-cols-3">{channels.map((c) => <Card key={c.provider}><CardTitle>{c.provider === 'whatsapp' ? 'WhatsApp' : c.provider === 'slack' ? 'Slack' : 'Signal'}</CardTitle><div className="mb-3 flex gap-2"><Badge tone={c.enabled ? 'ok' : 'muted'}>{c.enabled ? 'Available' : 'Off'}</Badge></div><Button disabled={!c.enabled} onClick={() => void mint(c.provider)}>Create link code</Button></Card>)}</div>
    <Card><CardTitle>Your linked identities</CardTitle>{links.length ? <ul className="space-y-2">{links.map((l) => <li key={l.id} className="flex items-center justify-between gap-2 border-b border-border py-2"><span className="text-sm">{plain('external_channel', l.provider)} · linked {new Date(l.linkedAt).toLocaleDateString()}</span><Button variant="secondary" onClick={() => void api.del(`/channels/links/${l.id}`).then(load)}>Disconnect</Button></li>)}</ul> : <Empty title="No external channels linked" />}</Card>
  </div>;
}
