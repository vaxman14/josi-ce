import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CipherState, Handshake, Session, fromHex, fromUtf8, generateKeyPair, staticKeyFrom, toHex, utf8 } from '@josi-ce/tunnel';

const load = (name: string) => JSON.parse(readFileSync(new URL(`./vectors/${name}`, import.meta.url), 'utf8'));

describe('Noise IK', () => {
  it('matches the published IK vector', async () => {
    const v = load('noise_vector_ik.json'), m = v.messages;
    const ini = new Handshake(true, staticKeyFrom(fromHex(v.init_static)), fromHex(v.init_remote_static), fromHex(v.init_prologue));
    const res = new Handshake(false, staticKeyFrom(fromHex(v.resp_static)), null, fromHex(v.resp_prologue));
    const one = await ini.writeFirst(fromHex(m[0].payload), fromHex(v.init_ephemeral));
    expect(toHex(one)).toBe(m[0].ciphertext);
    expect(toHex(await res.readFirst(one))).toBe(m[0].payload);
    const two = await res.writeSecond(fromHex(m[1].payload), fromHex(v.resp_ephemeral));
    expect(toHex(two)).toBe(m[1].ciphertext);
    expect(toHex(await ini.readSecond(two))).toBe(m[1].payload);
    const a = Session.from(ini), b = Session.from(res);
    m.slice(2, 6).forEach((message: { payload: string; ciphertext: string }, i: number) => {
      const [from, to] = i % 2 === 0 ? [a, b] : [b, a];
      const ct = from.seal(fromHex(message.payload));
      expect(toHex(ct)).toBe(message.ciphertext);
      expect(toHex(to.open(ct))).toBe(message.payload);
    });
  });

  it('matches the framing vector, rekeys included', () => {
    const v = load('framing.json'), key = fromHex(v.key);
    const s = new Session(new CipherState(key), new CipherState(new Uint8Array(32))).framed();
    const r = new Session(new CipherState(new Uint8Array(32)), new CipherState(key)).framed();
    s.rekeyMessages = v.rekey_messages;
    v.messages.forEach((message: string, i: number) => {
      const ct = s.seal(utf8(message));
      expect(toHex(ct)).toBe(v.ciphertexts[i]);
      expect(fromUtf8(r.open(ct))).toBe(message);
    });
  });

  it('refuses tampering and the wrong key', async () => {
    const server = staticKeyFrom(generateKeyPair().privateKey), device = staticKeyFrom(generateKeyPair().privateKey);
    const ini = new Handshake(true, device, server.publicKey), res = new Handshake(false, server);
    expect(fromUtf8(await res.readFirst(await ini.writeFirst(utf8('hello'))))).toBe('hello');
    expect(fromUtf8(await ini.readSecond(await res.writeSecond(utf8('welcome'))))).toBe('welcome');
    const a = Session.from(ini).framed(), b = Session.from(res).framed();
    const ct = a.seal(utf8('secret')); ct[0] ^= 1;
    expect(() => b.open(ct)).toThrow();
    const other = staticKeyFrom(generateKeyPair().privateKey);
    const wrong = await new Handshake(true, device, other.publicKey).writeFirst();
    await expect(new Handshake(false, server).readFirst(wrong)).rejects.toThrow();
  });

  it('pads so the relay learns sizes only to the nearest block', () => {
    const key = new Uint8Array(32).fill(7);
    const s = new Session(new CipherState(key), new CipherState(key)).framed();
    expect(s.seal(utf8('a')).length).toBe(s.seal(utf8('a'.repeat(200))).length);
  });
});
