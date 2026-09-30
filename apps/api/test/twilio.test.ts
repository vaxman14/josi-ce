import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import twilio from 'twilio';
import { WebSocket } from 'ws';
import { MasterKey, seal } from '@josi-ce/core';
import { consumeExternalLinkCode, mintExternalLinkCode, setExternalEnabled, setExternalProbe, storeExternalConfig } from '@josi-ce/channels';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import type { VoiceHelper } from '../src/http/voiceBoxRoutes.js';
import { TwilioMediaBridge } from '../src/http/twilioRoutes.js';

const dir = mkdtempSync(join(tmpdir(), 'josi-ce-twilio-'));
const keyPath = join(dir, 'master.key');
const bytes = Buffer.alloc(32, 73);
writeFileSync(keyPath, bytes.toString('base64'));
const key = new MasterKey(bytes);
const appUrl = 'https://josi.example';
const credentials = {
  accountSid: `AC${'1'.repeat(32)}`, authToken: 'twilio-test-auth-token-long-enough',
  messagingServiceSid: `MG${'2'.repeat(32)}`, phoneNumber: '+19517177772',
};

let db: TestDb; let server: Server; let base = ''; let adminId = ''; const helperCalls: string[] = [];
const llmBodies: string[] = [];
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
function silenceWav(): Buffer {
  const samples = Buffer.alloc(2400 * 2); const wav = Buffer.alloc(44 + samples.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44); return wav;
}
const voiceHelper: VoiceHelper = async (path) => {
  helperCalls.push(path);
  if (path === '/speech') return { status: 200, type: 'audio/wav', data: silenceWav() };
  const value = path === '/status' ? { healthy: true, verified: true, phase: 'ready' }
    : path === '/session' ? { session: 'a'.repeat(48) }
    : path === '/audio' ? { events: [{ type: 'speech_start' }, { type: 'final', text: 'hello Josi' }] }
    : { closed: true };
  return { status: 200, type: 'application/json', data: Buffer.from(JSON.stringify(value)) };
};

async function post(path: string, body: Record<string, string>, valid = true) {
  const publicUrl = appUrl + path;
  const signature = valid ? twilio.getExpectedTwilioSignature(credentials.authToken, publicUrl, body) : 'invalid';
  return fetch(base + path, { method: 'POST', headers: {
    'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature,
  }, body: new URLSearchParams(body), redirect: 'manual' });
}

beforeAll(async () => {
  db = await testDb(); await ensureWorkspace(db);
  const admin = await createUser(db, { email: 'admin@twilio.test', username: 'twilio-admin', role: 'super_admin', password: 'twilio-test-password-123' });
  adminId = admin.id;
  await storeExternalConfig(db, { provider: 'twilio', masterKey: key, actorUserId: admin.id, credentials });
  await setExternalProbe(db, 'twilio', true, null); await setExternalEnabled(db, 'twilio', true);
  await db.query(`insert into llm_providers
    (role,provider,model,api_key_enc,external_acknowledged,activated_at,probed_at,
     cap_chat,cap_structured_output,cap_tool_calling,cap_vision,cap_context_tokens)
    values ('primary','openai','gpt-test',$1,true,now(),now(),true,false,false,true,8000)`, [seal(key, { apiKey: 'test' })]);
  const connectorFetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.twilio.com/') && url.includes('/Media/'))
      return new Response(null, { status: 307, headers: { location: 'https://mms.twiliocdn.com/test-image' } });
    if (url === 'https://mms.twiliocdn.com/test-image')
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    if (url.endsWith('/Messages.json') && init?.method === 'POST')
      return new Response(JSON.stringify({ sid: `SM${'a'.repeat(32)}` }), { status: 201 });
    throw new Error(`unexpected connector fetch: ${url}`);
  };
  const llmFetch = async (_input: string | URL | Request, init?: RequestInit) => {
    llmBodies.push(String(init?.body ?? ''));
    return new Response(JSON.stringify({ id: 'answer', model: 'gpt-test',
      choices: [{ message: { role: 'assistant', content: 'I can see the image.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const app = createApp(db, { cookieSecure: false, appUrl, masterKeyCheck: { path: keyPath }, voiceBoxHelper: voiceHelper,
    connectorFetch: connectorFetch as typeof fetch, llmFetch: llmFetch as typeof fetch, llmResolve: async () => ['203.0.113.10'] });
  server = createServer(app);
  new TwilioMediaBridge({ db, appUrl, masterKey: { path: keyPath }, voiceHelper,
    llmResolve: async () => ['203.0.113.10'], llmFetch: async () => new Response(JSON.stringify({
      id: 'answer', model: 'gpt-test', choices: [{ message: { role: 'assistant', content: 'Hello from Josi.' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }) }).attach(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('Twilio public webhook boundary', () => {
  it('hides every webhook behind Twilio request validation', async () => {
    expect((await post('/channels/twilio/webhook', { MessageSid: `SM${'3'.repeat(32)}` }, false)).status).toBe(404);
    expect((await post('/channels/twilio/voice', { CallSid: `CA${'4'.repeat(32)}`, From: '+19515149294' }, false)).status).toBe(404);
    expect((await post('/channels/twilio/status', { MessageSid: `SM${'5'.repeat(32)}`, MessageStatus: 'sent' }, false)).status).toBe(404);
  });

  it('acknowledges an authentic SMS before asynchronous processing', async () => {
    const response = await post('/channels/twilio/webhook', { MessageSid: `SM${'6'.repeat(32)}`,
      From: 'invalid', To: credentials.phoneNumber, Body: '', NumMedia: '0' });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<Response></Response>');
  });

  it('accepts a real MMS, downloads its image, and passes it to the vision model', async () => {
    const phone = '+19515149293';
    const code = await mintExternalLinkCode(db, 'twilio', adminId);
    expect(await consumeExternalLinkCode(db, { provider: 'twilio', code: code.code,
      externalIdentity: phone, conversationId: phone })).not.toBeNull();
    const messageSid = `MM${'b'.repeat(32)}`; const mediaSid = `ME${'c'.repeat(32)}`;
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages/${messageSid}/Media/${mediaSid}`;
    const response = await post('/channels/twilio/webhook', { MessageSid: messageSid, From: phone,
      To: credentials.phoneNumber, Body: 'What is it?', NumMedia: '1', MediaUrl0: mediaUrl,
      MediaContentType0: 'image/png' });
    expect(response.status).toBe(200);
    for (let tries = 0; tries < 100; tries++) {
      const [event] = await db.query<{ outcome: string }>(
        "select outcome from external_channel_events where provider='twilio' and event_id=$1", [messageSid]);
      if (event?.outcome === 'accepted') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [event] = await db.query<{ outcome: string }>(
      "select outcome from external_channel_events where provider='twilio' and event_id=$1", [messageSid]);
    expect(event?.outcome).toBe('accepted');
    expect(llmBodies.some((body) => body.includes('data:image/png;base64,'))).toBe(true);
  });

  it('refuses an unlinked caller without opening a local voice session', async () => {
    const response = await post('/channels/twilio/voice', { CallSid: `CA${'7'.repeat(32)}`,
      From: '+19515149294', To: credentials.phoneNumber });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('not linked');
  });

  it('authenticates a media stream with a one-time call token before opening Voice Box', async () => {
    const phone = '+19515149294'; const callSid = `CA${'8'.repeat(32)}`; const streamSid = `MZ${'9'.repeat(32)}`;
    const token = 'stream-token-that-is-long-enough-for-the-test';
    const code = await mintExternalLinkCode(db, 'twilio', adminId);
    const link = await consumeExternalLinkCode(db, { provider: 'twilio', code: code.code, externalIdentity: phone, conversationId: phone });
    expect(link).not.toBeNull();
    await db.query(`insert into twilio_call_sessions(call_sid,user_id,external_identity,direction,stream_token_hash)
      values($1,$2,$3,'inbound',$4)`, [callSid, adminId, phone, createHash('sha256').update(token).digest('hex')]);
    const path = '/channels/twilio/voice/stream';
    const signature = twilio.getExpectedTwilioSignature(credentials.authToken, appUrl.replace(/^https:/, 'wss:') + path, {});
    const address = server.address() as AddressInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}${path}`, { headers: { 'X-Twilio-Signature': signature } });
    const outbound: Array<Record<string, unknown>> = [];
    ws.on('message', (raw) => outbound.push(JSON.parse(raw.toString()) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ event: 'start', streamSid, start: { streamSid, callSid, customParameters: { token, callSid } } }));
    for (let tries = 0; tries < 20; tries++) {
      const [row] = await db.query<{ state: string }>('select state from twilio_call_sessions where call_sid=$1', [callSid]);
      if (row?.state === 'connected') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [row] = await db.query<{ state: string; stream_sid: string }>('select state,stream_sid from twilio_call_sessions where call_sid=$1', [callSid]);
    expect(row).toEqual({ state: 'connected', stream_sid: streamSid });
    expect(helperCalls).toContain('/session');
    for (let tries = 0; tries < 100 && !outbound.some((event) => event.event === 'mark'); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outbound.some((event) => event.event === 'media')).toBe(true);
    expect(outbound.filter((event) => event.event === 'mark')).toHaveLength(1);
    const greetingSpeechCalls = helperCalls.filter((path) => path === '/speech').length;
    for (let index = 0; index < 25; index++) ws.send(JSON.stringify({ event: 'media', streamSid,
      media: { track: 'inbound', payload: Buffer.alloc(160, 0xff).toString('base64') } }));
    for (let tries = 0; tries < 100 && !helperCalls.includes('/audio'); tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    for (let tries = 0; tries < 100 && helperCalls.filter((path) => path === '/speech').length === greetingSpeechCalls; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(helperCalls).toContain('/audio');
    expect(helperCalls.filter((path) => path === '/speech').length).toBeGreaterThan(greetingSpeechCalls);
    expect(outbound.some((event) => event.event === 'media')).toBe(true);
    for (let tries = 0; tries < 100 && outbound.filter((event) => event.event === 'mark').length < 2; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(outbound.filter((event) => event.event === 'mark')).toHaveLength(2);
    ws.close();
    for (let tries = 0; tries < 100; tries++) {
      const [closed] = await db.query<{ state: string; ended: boolean }>(
        'select state,ended_at is not null as ended from twilio_call_sessions where call_sid=$1', [callSid]);
      if (closed?.state === 'completed' && closed.ended) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [closed] = await db.query<{ state: string; ended: boolean }>(
      'select state,ended_at is not null as ended from twilio_call_sessions where call_sid=$1', [callSid]);
    expect(closed).toEqual({ state: 'completed', ended: true });
  });
});
