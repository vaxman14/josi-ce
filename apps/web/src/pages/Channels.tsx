import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';

type Provider = 'whatsapp' | 'slack' | 'twilio';
interface Channel { provider: Provider; enabled: boolean; configured: boolean; probeOk: boolean | null }
interface ExternalLink { id: string; provider: Provider; status: string; linkedAt: string; lastInboundAt: string | null }
const label = (provider: Provider) => provider === 'whatsapp' ? 'WhatsApp' : provider === 'slack' ? 'Slack' : 'Twilio';

export function Channels() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [links, setLinks] = useState<ExternalLink[]>([]);
  const [instruction, setInstruction] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const result = await api.get<{ channels: Channel[]; links: ExternalLink[] }>('/channels');
    setChannels(result.channels); setLinks(result.links);
  }, []);
  useEffect(() => { void load().catch((e) => setError(e instanceof Error ? e.message : 'Could not load channels')); }, [load]);
  async function mint(provider: Provider) {
    try {
      setError('');
      const result = await api.post<{ instruction: string }>(`/channels/${provider}/link-code`);
      setInstruction(result.instruction);
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not create a link code'); }
  }
  async function callMe() {
    try { setError(''); setInstruction(''); await api.post('/channels/twilio/call-me'); setInstruction('Josi is calling your linked phone now.'); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not start the call'); }
  }
  return <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
    <div><h1 className="text-xl font-semibold tracking-tight">Channels</h1><p className="text-sm text-muted-foreground">Ways to reach the same private Josi workspace from another app.</p></div>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    {instruction ? <Card><CardTitle>One-time link code</CardTitle><p className="break-all text-sm">{instruction}</p><p className="mt-2 text-xs text-muted-foreground">Expires in 10 minutes and works once.</p></Card> : null}
    <Card><details><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden"><span><CardTitle>Telegram</CardTitle><span className="text-sm text-muted-foreground">Link your own Telegram chat.</span></span><span aria-hidden className="text-muted-foreground">⌄</span></summary><div className="mt-3 border-t border-border pt-3"><Link to="/app/channels/telegram" className="inline-flex min-h-11 items-center text-sm underline">Set up Telegram</Link></div></details></Card>
    {channels.map((channel) => <Card key={channel.provider}><details><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden"><span><CardTitle>{label(channel.provider)}</CardTitle><span className="text-sm text-muted-foreground">{channel.provider === 'twilio' ? 'Text or call the same private Josi workspace.' : <>Message Josi from {label(channel.provider)}.</>}</span></span><span className="flex items-center gap-2"><Badge tone={channel.enabled ? 'ok' : 'muted'}>{channel.enabled ? 'Available' : 'Off'}</Badge><span aria-hidden className="text-muted-foreground">⌄</span></span></summary><div className="mt-3 border-t border-border pt-3"><p className="mb-3 text-sm text-muted-foreground">Create a single-use code here, then send the displayed instruction to Josi in {label(channel.provider)}.</p><div className="flex flex-wrap gap-2"><Button disabled={!channel.enabled} onClick={() => void mint(channel.provider)}>Create link code</Button>{channel.provider === 'twilio' && links.some((link) => link.provider === 'twilio' && link.status === 'active') ? <Button variant="secondary" onClick={() => void callMe()}>Call me</Button> : null}</div></div></details></Card>)}
    <Card><details><summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden"><CardTitle>Your linked identities</CardTitle><span className="flex items-center gap-2"><Badge>{links.length}</Badge><span aria-hidden className="text-muted-foreground">⌄</span></span></summary><div className="mt-3 border-t border-border pt-3">{links.length ? <ul className="space-y-2">{links.map((link) => <li key={link.id} className="flex items-center justify-between gap-2 border-b border-border py-2"><span className="text-sm">{plain('external_channel', link.provider)} · linked {new Date(link.linkedAt).toLocaleDateString()}</span><Button variant="secondary" onClick={() => void api.del(`/channels/links/${link.id}`).then(load)}>Disconnect</Button></li>)}</ul> : <Empty title="No external channels linked" />}</div></details></Card>
  </div>;
}
