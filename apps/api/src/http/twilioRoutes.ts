import { createHash, randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import express, { Router, type Express, type Request } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { loadMasterKey, type Db, type LoadOptions, type MasterKey } from '@josi-ce/core';
import {
  configureTwilioNumber, listExternalLinks, loadExternalConfig, normalizeTwilioSms,
  openExternalConfig, resolveExternalLink, startTwilioCall, verifyTwilioSignature,
  type ExternalLinkRow,
} from '@josi-ce/channels';
import { requireAuth, requireSuperAdmin } from './authz.js';
import { asyncRoute } from './async.js';
import { processInbound, runLinkedExternalTurn, type ExternalChannelCtx } from './externalChannelRoutes.js';
import type { VoiceHelper } from './voiceBoxRoutes.js';

export interface TwilioRoutesCtx extends ExternalChannelCtx { voiceHelper: VoiceHelper }

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const xml = (value: string) => value.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]!));
const twiml = (body = '') => `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;

function keyOf(ctx: TwilioRoutesCtx): MasterKey | null {
  if (ctx.masterKey === false) return null;
  try { return loadMasterKey(ctx.masterKey ?? undefined); } catch { return null; }
}

function form(req: Request): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.body ?? {})) if (typeof value === 'string') result[name] = value;
  return result;
}

async function secretsOf(ctx: TwilioRoutesCtx): Promise<Record<string, string> | null> {
  const row = await loadExternalConfig(ctx.db, 'twilio');
  if (!row.enabled) return null;
  try { return openExternalConfig(keyOf(ctx), row); } catch { return null; }
}

function authentic(req: Request, ctx: TwilioRoutesCtx, secrets: Record<string, string>): boolean {
  return verifyTwilioSignature(secrets.authToken, req.get('x-twilio-signature'),
    `${ctx.appUrl}${req.originalUrl}`, form(req));
}

export function mountTwilioWebhooks(app: Express, ctx: TwilioRoutesCtx): void {
  const parse = express.urlencoded({ extended: false, limit: '128kb' });
  app.post('/channels/twilio/webhook', parse, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const secrets = await secretsOf(ctx);
    if (!secrets || !authentic(req, ctx, secrets)) return res.status(404).send('not found');
    const messages = normalizeTwilioSms(req.body as Record<string, unknown>);
    res.status(200).type('text/xml').send(twiml());
    for (const message of messages) void processInbound(ctx, secrets, message)
      .catch((err) => console.error('twilio sms failed', (err as Error).message));
  }));

  app.post('/channels/twilio/status', parse, asyncRoute(async (req, res) => {
    const secrets = await secretsOf(ctx);
    if (!secrets || !authentic(req, ctx, secrets)) return res.status(404).send('not found');
    const values = form(req); const sid = values.MessageSid; const state = values.MessageStatus;
    if (/^SM[0-9a-fA-F]{32}$/.test(sid ?? '') && ['sent', 'delivered', 'failed', 'undelivered'].includes(state ?? '')) {
      await ctx.db.query(`update external_channel_outbound set state=$2,error_category=$3,
        sent_at=case when $2 in ('sent','delivered') then coalesce(sent_at,now()) else sent_at end
        where provider='twilio' and provider_message_id=$1`,
      [sid, state === 'delivered' ? 'sent' : state === 'undelivered' ? 'failed' : state,
        ['failed', 'undelivered'].includes(state) ? 'delivery_failed' : null]);
    }
    res.status(204).end();
  }));

  app.post('/channels/twilio/voice', parse, asyncRoute(async (req, res) => {
    const secrets = await secretsOf(ctx);
    if (!secrets || !authentic(req, ctx, secrets)) return res.status(404).send('not found');
    const values = form(req); const callSid = values.CallSid;
    if (!/^CA[0-9a-fA-F]{32}$/.test(callSid ?? '')) return res.status(400).type('text/xml').send(twiml('<Hangup/>'));
    const [busy] = await ctx.db.query<{ call_sid: string }>(
      "select call_sid from twilio_call_sessions where state in ('created','ringing','connected') and call_sid<>$1 limit 1", [callSid]);
    if (busy) return res.status(200).type('text/xml').send(twiml('<Say>Josi is already on another call. Please try again shortly.</Say><Hangup/>'));
    let [session] = await ctx.db.query<{ call_sid: string; user_id: string; external_identity: string; stream_token_hash: string }>(
      'select call_sid,user_id,external_identity,stream_token_hash from twilio_call_sessions where call_sid=$1', [callSid]);
    let token = '';
    if (!session) {
      token = randomBytes(32).toString('base64url');
      const intent = typeof req.query.intent === 'string' ? req.query.intent : '';
      const [outbound] = intent.length >= 32 ? await ctx.db.query<{ user_id: string; external_identity: string; thread_id: string | null }>(
        'delete from twilio_call_intents where token_hash=$1 and expires_at>now() returning user_id,external_identity,thread_id', [sha256(intent)]) : [];
      if (outbound) {
        [session] = await ctx.db.query(`insert into twilio_call_sessions
          (call_sid,user_id,external_identity,direction,stream_token_hash,thread_id)
          values($1,$2,$3,'outbound',$4,$5)
          returning call_sid,user_id,external_identity,stream_token_hash`,
        [callSid, outbound.user_id, outbound.external_identity, sha256(token), outbound.thread_id]);
      } else {
        const from = values.From ?? '';
        const link = await resolveExternalLink(ctx.db, 'twilio', from);
        if (!link) return res.status(200).type('text/xml').send(twiml('<Say>This phone number is not linked to a Josi account.</Say><Hangup/>'));
        [session] = await ctx.db.query(`insert into twilio_call_sessions
          (call_sid,user_id,external_identity,direction,stream_token_hash,thread_id)
          values($1,$2,$3,'inbound',$4,$5)
          returning call_sid,user_id,external_identity,stream_token_hash`,
        [callSid, link.user_id, from, sha256(token), link.thread_id]);
      }
    } else {
      token = randomBytes(32).toString('base64url');
      await ctx.db.query('update twilio_call_sessions set stream_token_hash=$2,updated_at=now() where call_sid=$1', [callSid, sha256(token)]);
    }
    try {
      const status = JSON.parse((await ctx.voiceHelper('/status')).data.toString()) as Record<string, unknown>;
      if (status.healthy !== true || status.verified !== true || status.phase !== 'ready') throw new Error('not ready');
    } catch {
      return res.status(200).type('text/xml').send(twiml('<Say>Local voice is not ready. Please try again later.</Say><Hangup/>'));
    }
    const wsUrl = ctx.appUrl.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:') + '/channels/twilio/voice/stream';
    const stream = `<Connect><Stream url="${xml(wsUrl)}"><Parameter name="token" value="${xml(token)}"/><Parameter name="callSid" value="${xml(callSid)}"/></Stream></Connect>`;
    return res.status(200).type('text/xml').send(twiml(stream));
  }));

  app.post('/channels/twilio/call-status', parse, asyncRoute(async (req, res) => {
    const secrets = await secretsOf(ctx);
    if (!secrets || !authentic(req, ctx, secrets)) return res.status(404).send('not found');
    const values = form(req); const sid = values.CallSid; const status = values.CallStatus;
    const state = status === 'in-progress' ? 'connected' : status === 'completed' ? 'completed'
      : ['busy', 'failed', 'no-answer', 'canceled'].includes(status) ? 'failed'
      : ['initiated', 'queued'].includes(status) ? 'created' : status === 'ringing' ? 'ringing' : null;
    if (/^CA[0-9a-fA-F]{32}$/.test(sid ?? '') && state) await ctx.db.query(
      `update twilio_call_sessions set state=$2,connected_at=case when $2='connected' then coalesce(connected_at,now()) else connected_at end,
       ended_at=case when $2 in ('completed','failed') then now() else ended_at end,updated_at=now() where call_sid=$1`, [sid, state]);
    res.status(204).end();
  }));
}

export function twilioAdminRoutes(ctx: TwilioRoutesCtx): Router {
  const r = Router(); r.use(requireSuperAdmin);
  r.post('/register-webhooks', asyncRoute(async (_req, res) => {
    const secrets = await secretsOf(ctx);
    if (!secrets) return res.status(409).json({ error: 'Configure, test, and enable Twilio first' });
    await configureTwilioNumber({ credentials: secrets, smsUrl: `${ctx.appUrl}/channels/twilio/webhook`,
      voiceUrl: `${ctx.appUrl}/channels/twilio/voice`, fetchImpl: ctx.fetchImpl });
    res.json({ registered: true });
  }));
  return r;
}

export function twilioMemberRoutes(ctx: TwilioRoutesCtx): Router {
  const r = Router(); r.use(requireAuth);
  r.post('/call-me', asyncRoute(async (req, res) => {
    if (Object.keys(req.body ?? {}).length) return res.status(400).json({ error: 'Call me accepts no parameters' });
    const secrets = await secretsOf(ctx);
    if (!secrets) return res.status(409).json({ error: 'Twilio is not available on this installation' });
    const link = (await listExternalLinks(ctx.db, req.user!.id)).find((item) => item.provider === 'twilio' && item.status === 'active');
    if (!link) return res.status(409).json({ error: 'Link your phone to Twilio SMS first' });
    const [busy] = await ctx.db.query<{ call_sid: string }>(
      "select call_sid from twilio_call_sessions where state in ('created','ringing','connected') limit 1");
    if (busy) return res.status(409).json({ error: 'Josi is already on another call' });
    const intent = randomBytes(32).toString('base64url');
    await ctx.db.query(`insert into twilio_call_intents(token_hash,user_id,external_identity,thread_id,expires_at)
      values($1,$2,$3,$4,now()+interval '5 minutes')`, [sha256(intent), req.user!.id, link.external_identity, link.thread_id]);
    try {
      const callSid = await startTwilioCall({ credentials: secrets, to: link.external_identity,
        voiceUrl: `${ctx.appUrl}/channels/twilio/voice?intent=${encodeURIComponent(intent)}`,
        statusCallback: `${ctx.appUrl}/channels/twilio/call-status`, fetchImpl: ctx.fetchImpl });
      await ctx.db.query(`with claimed as (
        delete from twilio_call_intents where token_hash=$2 returning user_id,external_identity,thread_id)
        insert into twilio_call_sessions(call_sid,user_id,external_identity,direction,stream_token_hash,thread_id)
        select $1,user_id,external_identity,'outbound',$3,thread_id from claimed on conflict do nothing`,
      [callSid, sha256(intent), sha256(randomBytes(32).toString('base64url'))]);
      res.status(202).json({ started: true, callSid });
    } catch (err) {
      await ctx.db.query('delete from twilio_call_intents where token_hash=$1', [sha256(intent)]);
      throw err;
    }
  }));
  return r;
}

interface CallSessionRow { call_sid: string; user_id: string; external_identity: string; stream_token_hash: string; thread_id: string | null }
interface TwilioSocketState { streamSid: string; call: CallSessionRow; link: ExternalLinkRow; voiceSession: string;
  seq: number; audio: Buffer; processing: boolean; queue: Buffer[]; playing: boolean; closed: boolean }

export class TwilioMediaBridge {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 });
  private activeCallSid: string | null = null;
  private starting = false;
  constructor(private readonly ctx: TwilioRoutesCtx) {}

  attach(server: Server): void {
    server.on('upgrade', (req, socket, head) => {
      void (async () => {
        const url = new URL(req.url ?? '/', this.ctx.appUrl);
        if (url.pathname !== '/channels/twilio/voice/stream') return;
        const secrets = await secretsOf(this.ctx);
        const signature = Array.isArray(req.headers['x-twilio-signature']) ? req.headers['x-twilio-signature'][0] : req.headers['x-twilio-signature'];
        if (!secrets || !verifyTwilioSignature(secrets.authToken, signature, `${this.ctx.appUrl}${url.pathname}`, {})) return socket.destroy();
        this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
      })().catch(() => socket.destroy());
    });
    this.wss.on('connection', (ws) => this.connected(ws));
  }

  private connected(ws: WebSocket): void {
    let state: TwilioSocketState | null = null;
    const timer = setTimeout(() => { if (!state) ws.close(1008, 'start required'); }, 10_000);
    ws.on('message', (raw) => { void (async () => {
      const message = JSON.parse(raw.toString()) as Record<string, any>;
      if (message.event === 'start' && !state) {
        state = await this.start(message);
        clearTimeout(timer);
        return;
      }
      if (!state) return;
      if (message.event === 'media' && message.media?.track !== 'outbound') {
        const chunk = Buffer.from(String(message.media?.payload ?? ''), 'base64');
        if (chunk.length > 8000 || state.queue.length > 1000) throw new Error('audio bounds exceeded');
        state.queue.push(chunk); void this.pump(ws, state);
      }
      if (message.event === 'mark') state.playing = false;
      if (message.event === 'stop') ws.close(1000);
    })().catch((err) => { console.error('twilio media failed', (err as Error).message); ws.close(1011); }); });
    ws.on('close', () => { clearTimeout(timer); if (state) { state.closed = true;
      if (this.activeCallSid === state.call.call_sid) this.activeCallSid = null;
      void this.ctx.voiceHelper('/close', { session: state.voiceSession }).catch(() => undefined); } });
  }

  private async start(message: Record<string, any>): Promise<TwilioSocketState> {
    const streamSid = String(message.start?.streamSid ?? message.streamSid ?? '');
    const callSid = String(message.start?.callSid ?? message.start?.customParameters?.callSid ?? '');
    const token = String(message.start?.customParameters?.token ?? '');
    if (!/^MZ[0-9a-fA-F]{32}$/.test(streamSid) || !/^CA[0-9a-fA-F]{32}$/.test(callSid) || token.length < 32) throw new Error('invalid stream start');
    const [call] = await this.ctx.db.query<CallSessionRow>('select call_sid,user_id,external_identity,stream_token_hash,thread_id from twilio_call_sessions where call_sid=$1', [callSid]);
    if (!call || call.stream_token_hash !== sha256(token)) throw new Error('invalid stream token');
    if (this.starting || (this.activeCallSid && this.activeCallSid !== callSid)) throw new Error('voice call capacity reached');
    this.starting = true;
    try {
      const link = await resolveExternalLink(this.ctx.db, 'twilio', call.external_identity);
      if (!link || link.user_id !== call.user_id) throw new Error('linked identity revoked');
      const reply = await this.ctx.voiceHelper('/session', {});
      if (reply.status !== 200) throw new Error('voice session unavailable');
      const voiceSession = (JSON.parse(reply.data.toString()) as { session?: string }).session ?? '';
      if (!/^[0-9a-f]{48}$/.test(voiceSession)) throw new Error('invalid voice session');
      await this.ctx.db.query("update twilio_call_sessions set state='connected',stream_sid=$2,connected_at=coalesce(connected_at,now()),updated_at=now() where call_sid=$1", [callSid, streamSid]);
      this.activeCallSid = callSid;
      return { streamSid, call, link, voiceSession, seq: 0, audio: Buffer.alloc(0), processing: false, queue: [], playing: false, closed: false };
    } finally { this.starting = false; }
  }

  private async pump(ws: WebSocket, state: TwilioSocketState): Promise<void> {
    if (state.processing || state.closed) return;
    state.processing = true;
    try {
      while (state.queue.length && !state.closed) {
        state.audio = Buffer.concat([state.audio, state.queue.shift()!]);
        if (state.audio.length < 4000) continue;
        const mulaw = state.audio.subarray(0, 4000); state.audio = state.audio.subarray(4000);
        const pcm = upsampleMulaw(mulaw).toString('base64');
        const response = await this.ctx.voiceHelper('/audio', { session: state.voiceSession, seq: state.seq++, pcm });
        if (response.status !== 200) throw new Error('speech recognition unavailable');
        const events = (JSON.parse(response.data.toString()) as { events?: Array<{ type?: string; text?: string }> }).events ?? [];
        if (events.some((event) => event.type === 'speech_start') && state.playing) {
          ws.send(JSON.stringify({ event: 'clear', streamSid: state.streamSid })); state.playing = false;
        }
        const final = events.find((event) => event.type === 'final' && event.text?.trim());
        if (final?.text) await this.answer(ws, state, final.text.trim());
      }
    } finally { state.processing = false; }
  }

  private async answer(ws: WebSocket, state: TwilioSocketState, inbound: string): Promise<void> {
    const turn = await runLinkedExternalTurn(this.ctx, state.link, inbound, 'twilio');
    for (const part of speechParts(turn.reply)) {
      if (state.closed) return;
      const speech = await this.ctx.voiceHelper('/speech', { text: part });
      if (speech.status !== 200) throw new Error('speech synthesis unavailable');
      const audio = wavToMulaw(speech.data);
      for (let offset = 0; offset < audio.length; offset += 800) ws.send(JSON.stringify({ event: 'media', streamSid: state.streamSid,
        media: { payload: audio.subarray(offset, offset + 800).toString('base64') } }));
    }
    state.playing = true;
    ws.send(JSON.stringify({ event: 'mark', streamSid: state.streamSid, mark: { name: randomBytes(8).toString('hex') } }));
  }
}

function speechParts(value: string): string[] {
  const parts = value.trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g)?.map((part) => part.trim()).filter(Boolean) ?? [];
  const result: string[] = [];
  for (const part of parts) for (let start = 0; start < part.length; start += 500) result.push(part.slice(start, start + 500));
  return result.slice(0, 12);
}

function upsampleMulaw(input: Buffer): Buffer {
  const output = Buffer.allocUnsafe(input.length * 4);
  for (let index = 0; index < input.length; index++) {
    const sample = decodeMulaw(input[index]);
    output.writeInt16LE(sample, index * 4); output.writeInt16LE(sample, index * 4 + 2);
  }
  return output;
}

function decodeMulaw(value: number): number {
  value = ~value & 0xff;
  const sign = value & 0x80; const exponent = (value >> 4) & 0x07; const mantissa = value & 0x0f;
  const sample = ((mantissa << 3) + 0x84) << exponent;
  return sign ? 0x84 - sample : sample - 0x84;
}

function encodeMulaw(sample: number): number {
  const BIAS = 0x84; const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  sample = Math.min(CLIP, sample) + BIAS;
  let exponent = 7;
  for (let mask = 0x4000; exponent > 0 && !(sample & mask); exponent--, mask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

function wavToMulaw(wav: Buffer): Buffer {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') throw new Error('invalid speech audio');
  const rate = wav.readUInt32LE(24); const channels = wav.readUInt16LE(22); const bits = wav.readUInt16LE(34);
  if (rate !== 24000 || channels !== 1 || bits !== 16) throw new Error('unsupported speech audio');
  const dataAt = wav.indexOf(Buffer.from('data'), 12);
  if (dataAt < 0 || dataAt + 8 > wav.length) throw new Error('missing speech audio');
  const length = Math.min(wav.readUInt32LE(dataAt + 4), wav.length - dataAt - 8);
  const pcm = wav.subarray(dataAt + 8, dataAt + 8 + length);
  const output = Buffer.alloc(Math.floor(pcm.length / 6));
  for (let out = 0, offset = 0; out < output.length; out++, offset += 6) output[out] = encodeMulaw(pcm.readInt16LE(offset));
  return output;
}
