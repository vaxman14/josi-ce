import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';
import { neighborSpeechHelper, type VoiceHelper } from '../src/http/voiceBoxRoutes.js';
import { twilioPhonePreviewWav } from '../src/http/twilioRoutes.js';
import { speechChunks, takeVoiceFrame } from '../../web/src/lib/voiceAudio.js';
import { mountWebApp } from '../src/http/staticApp.js';

let db: TestDb, server: Server, base: string;

describe('Voice Box capture backpressure', () => {
  it('coalesces queued half-second frames into one gateway-sized request', () => {
    const frames = [new Uint8Array(16_000).fill(1), new Uint8Array(16_000).fill(2), new Uint8Array(16_000).fill(3)];
    const request = takeVoiceFrame(frames);
    expect(request).toHaveLength(32_000);
    expect(request[0]).toBe(1);
    expect(request[16_000]).toBe(2);
    expect(frames).toHaveLength(1);
  });

  it('rejects a capture frame larger than the gateway limit', () => {
    expect(() => takeVoiceFrame([new Uint8Array(32_001)])).toThrow(/oversized/);
  });
});

describe('Neighbor speech and phone conversion', () => {
  it('uses the private Neighbor endpoint for speech and retains local fallback', async () => {
    const local = vi.fn<VoiceHelper>(async () => ({ status: 200, type: 'audio/wav', data: Buffer.from('local') }));
    const remote = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(Buffer.from('neighbor'), {
      status: 200, headers: { 'content-type': 'audio/wav' },
    })).mockRejectedValueOnce(new Error('offline'));
    const helper = neighborSpeechHelper(local, 'http://10.10.1.30:3911', 'x'.repeat(64));
    expect((await helper('/speech', { text: 'hello' })).data.toString()).toBe('neighbor');
    expect((await helper('/speech', { text: 'hello again' })).data.toString()).toBe('local');
    expect((await helper('/status')).data.toString()).toBe('local');
    expect(remote).toHaveBeenCalledTimes(2);
    remote.mockRestore();
  });

  it('anti-aliases 24 kHz speech before Twilio mu-law conversion', () => {
    const tone = (frequency: number) => {
      const samples = Buffer.alloc(12000 * 2);
      for (let index = 0; index < 12000; index++) samples.writeInt16LE(
        Math.round(Math.sin(2 * Math.PI * frequency * index / 24000) * 20000), index * 2);
      const wav = Buffer.alloc(44 + samples.length);
      wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
      wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44);
      return twilioPhonePreviewWav(wav).subarray(44);
    };
    const rms = (pcm: Buffer) => {
      let energy = 0;
      for (let offset = 200; offset < pcm.length - 200; offset += 2) energy += pcm.readInt16LE(offset) ** 2;
      return Math.sqrt(energy / ((pcm.length - 400) / 2));
    };
    expect(rms(tone(6000))).toBeLessThan(rms(tone(1000)) * 0.1);
  });
});
const jars: Record<string, string> = {};
const calls: { path: string; body: unknown }[] = [];
let ready = false;
let helperDown = false;
let serial = 0;
function silenceWav(): Buffer {
  const samples = Buffer.alloc(2400 * 2); const wav = Buffer.alloc(44 + samples.length);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24);
  wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples.length, 40); samples.copy(wav, 44); return wav;
}
const helper: VoiceHelper = async (path, body) => {
  calls.push({ path, body });
  if (helperDown) throw new Error('private socket error');
  if (path === '/speech') return { status: 200, type: 'audio/wav', data: silenceWav() };
  const data = path === '/status' ? { healthy: ready, verified: ready, phase: ready ? 'ready' : 'absent', privateHost: 'should not reach members' }
    : path === '/session' ? { session: (++serial).toString(16).padStart(48, '0') }
    : path === '/audio' ? { events: [{ type: 'final', text: 'hello' }] } : { ok: true };
  return { status: 200, type: 'application/json', data: Buffer.from(JSON.stringify(data)) };
};
function jar(parts: string[]) { return parts.map((s) => s.split(';')[0]).join('; '); }
async function call(path: string, who?: string, body?: unknown, csrf = true) {
  const cookie = who ? jars[who] : '';
  const token = /josi_csrf=([^;]+)/.exec(cookie)?.[1] ?? '';
  return fetch(base + '/api' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { cookie, 'Content-Type': 'application/json', ...(csrf ? { 'x-josi-csrf': decodeURIComponent(token) } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
}
beforeAll(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  for (const name of ['admin', 'alice', 'bob']) await createUser(db, { email: name + '@voice.test', username: name,
    role: name === 'admin' ? 'super_admin' : 'member', password: 'voice-test-password-123' });
  const app = createApp(db, { cookieSecure: false, appUrl: 'http://localhost', masterKeyCheck: false, voiceBoxHelper: helper });
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const name of ['admin', 'alice', 'bob']) {
    const pre = await fetch(base + '/api/auth/csrf');
    jars[name] = jar(pre.headers.getSetCookie());
    const response = await call('/auth/login', name, { identifier: name, password: 'voice-test-password-123' });
    expect(response.status).toBe(200);
    jars[name] += '; ' + jar(response.headers.getSetCookie());
  }
});
afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });

describe('Voice Box API security and lifecycle', () => {
  it('requires sign-in and super-admin authority before contacting the helper', async () => {
    for (const suffix of ['', '/install', '/settings', '/restart', '/update', '/rollback', '/uninstall', '/preview']) {
      const before = calls.length;
      expect((await call('/admin/voice-box' + suffix, 'alice', suffix ? {} : undefined)).status).toBe(403);
      expect((await call('/admin/voice-box' + suffix, undefined, suffix ? {} : undefined)).status).toBeGreaterThanOrEqual(400);
      expect(calls.length).toBe(before);
    }
    expect((await call('/admin/channels/twilio/voice-preview', 'alice', {})).status).toBe(403);
    expect((await call('/admin/channels/twilio/voice-preview', undefined, {})).status).toBeGreaterThanOrEqual(400);
    expect((await call('/voice/status')).status).toBe(401);
  });
  it('refuses CSRF, arbitrary operations and installation arguments', async () => {
    const before = calls.length;
    expect((await call('/admin/voice-box/install', 'admin', {}, false)).status).toBe(403);
    expect((await call('/admin/voice-box/exec', 'admin', {})).status).toBe(404);
    expect((await call('/admin/voice-box/install', 'admin', { image: 'hostile', mounts: ['/'] })).status).toBe(400);
    expect(calls.length).toBe(before);
    expect((await call('/admin/voice-box/install', 'admin', {})).status).toBe(200);
    expect(calls.at(-1)).toEqual({ path: '/operation/install', body: {} });
  });
  it('does not preview before model verification, or expose host metadata to members', async () => {
    ready = false;
    expect((await call('/admin/voice-box/preview', 'admin', {})).status).toBe(409);
    expect(await (await call('/voice/status', 'alice')).json()).toEqual({ available: false });
    ready = true;
    expect(await (await call('/voice/status', 'alice')).json()).toEqual({ available: true });
    expect((await call('/admin/voice-box/preview', 'admin', {})).status).toBe(200);
    expect(calls.at(-1)?.path).toBe('/speech');
  });
  it('previews the exact Twilio greeting through an 8 kHz phone-quality WAV without placing a call', async () => {
    ready = true;
    const response = await call('/admin/channels/twilio/voice-preview', 'admin', {});
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('audio/wav');
    const wav = Buffer.from(await response.arrayBuffer());
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(8000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(calls.at(-1)).toEqual({ path: '/speech', body: { text: 'Hi. Josi here. How can I help?' } });
  });
  it('binds audio and close requests to the signed-in session owner, including against admins', async () => {
    const { session } = await (await call('/voice/session', 'alice', {})).json() as { session: string };
    expect((await call('/voice/session', 'alice', {})).status).toBe(429);
    const frame = { session, pcm: Buffer.alloc(16000).toString('base64'), seq: 0 };
    for (const who of ['bob', 'admin']) {
      expect((await call('/voice/audio', who, frame)).status).toBe(404);
      expect((await call('/voice/close', who, { session })).status).toBe(404);
    }
    expect((await call('/voice/audio', 'alice', { ...frame, seq: 1.5 })).status).toBe(400);
    expect((await call('/voice/audio', 'alice', { ...frame, pcm: 'a'.repeat(45000) })).status).toBe(400);
    expect((await call('/voice/audio', 'alice', frame)).status).toBe(200);
    expect((await call('/voice/close', 'alice', { session })).status).toBe(200);
    expect((await call('/voice/audio', 'alice', frame)).status).toBe(404);
  });
  it('rejects oversized speech and reports absent helpers without private errors', async () => {
    expect((await call('/voice/speech', 'alice', { text: 'x'.repeat(601) })).status).toBe(400);
    helperDown = true;
    const status = await (await call('/admin/voice-box', 'admin')).json();
    expect(status.helperAvailable).toBe(false);
    expect(JSON.stringify(status)).not.toContain('private socket');
    expect(await (await call('/voice/status', 'alice')).json()).toEqual({ available: false });
    helperDown = false;
  });
});
it('preserves all reply text while bounding speech requests', () => {
  const text = 'A long reply. ' + 'word '.repeat(300) + 'z'.repeat(900);
  const chunks = speechChunks(text);
  expect(chunks.every((part) => part.length <= 400)).toBe(true);
  expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
});
it('keeps microphone permissions off unless the operator enables the integration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'voice-policy-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Voice policy fixture</title>');
  for (const voiceEnabled of [false, true]) {
    const app = express();
    mountWebApp(app, { dir, voiceEnabled });
    const local = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(local.address() as AddressInfo).port}/`);
      expect(response.headers.get('permissions-policy')).toContain(`microphone=${voiceEnabled ? '(self)' : '()'}`);
      expect(response.headers.get('permissions-policy')).toContain('camera=()');
      await response.text();
    } finally { await new Promise<void>((resolve) => local.close(() => resolve())); }
  }
});
