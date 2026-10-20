import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseProtectedControlChallenge, protectedControlMessage, isProtectedControlOrigin, type ProtectedControlChallenge } from '@josi-ce/protocol';
import { createProtectedConfirmationBroker, verifyProtectedControlSignature, type ProtectedConfirmationPorts } from '../src/protectedConfirmation.js';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { serverOrigin: 'https://josi.example.test', serverId: id(1), userId: id(2), deviceId: id(3) };
function challenge(): ProtectedControlChallenge {
  return { schemaVersion: 1, id: id(4), nonce: randomBytes(32).toString('base64url'), ...identity, purpose: 'cardinal.activate',
    requestDigest: 'a'.repeat(64), keyReference: { recordId: id(5), version: 1, digest: 'b'.repeat(64), epoch: 7 }, issuedAtMs: 1000, expiresAtMs: 61_000,
    presentation: { wording: 'Deny shell execution.', meaning: 'Deny execution.shell for every automation workspace.', advisory: ['Check whether this scope matches your intended work.'] } };
}
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const cancellations: Array<() => void> = [];
afterEach(() => { cancellations.splice(0).forEach(cancel => cancel()); vi.useRealTimers(); });
function fixture(patch: Partial<ProtectedConfirmationPorts> = {}) {
  let wall = 1001, mono = 100;
  const source = challenge(), key = generateKeyPairSync('ed25519');
  const signing = vi.fn<ProtectedConfirmationPorts['sign']>(async (_challenge, bytes) => sign(null, bytes, key.privateKey).toString('base64url'));
  const authenticate = vi.fn<ProtectedConfirmationPorts['authenticate']>(async () => undefined); // fixture, NOT an OS biometric proof
  const ports: ProtectedConfirmationPorts = { loadChallenge: async () => source, present: async () => true, authenticate,
    isCurrent: async () => true, sign: signing, clock: () => ({ wallMs: wall, monotonicMs: mono }), ...patch };
  const broker = createProtectedConfirmationBroker(identity, ports); cancellations.push(broker.cancel);
  return { source, key, ports, broker, signing, authenticate, clock: (w: number, m = w) => { wall += w; mono += m; } };
}
describe('strict protected-control challenge', () => {
  it('uses HTTPS remotely and allows only exact loopback HTTP origins for local service control', () => {
    for (const origin of ['https://josi.example.test', 'https://josi.example.test:8443', 'http://127.0.0.1:8080', 'http://[::1]:8080', 'http://localhost:8080']) expect(isProtectedControlOrigin(origin)).toBe(true);
    for (const origin of ['http://10.0.0.1', 'http://192.168.1.2', 'http://evil.test', 'https://josi.example.test/', 'https://u:p@josi.example.test',
      'https://josi.example.test?secret=value', 'https://josi.example.test#x', 'https://JOSI.example.test', 'https://*.test']) expect(isProtectedControlOrigin(origin)).toBe(false);
  });
  it('canonicalizes field order but binds presentation, advisory, authority and exact command', () => {
    const c = challenge();
    expect(protectedControlMessage(c)).toBe(protectedControlMessage(Object.fromEntries(Object.entries(c).reverse()) as never));
    for (const patch of [{ requestDigest: 'c'.repeat(64) }, { keyReference: { ...c.keyReference, epoch: 8 } },
      { presentation: { ...c.presentation, meaning: 'A different permission.' } }, { presentation: { ...c.presentation, advisory: ['A different advisory.'] } }]) {
      expect(protectedControlMessage({ ...c, ...patch })).not.toBe(protectedControlMessage(c));
    }
  });
  it.each([null, {}, { ...challenge(), humanApproved: true }, { ...challenge(), purpose: 'execute.shell' },
    { ...challenge(), nonce: 'short' }, { ...challenge(), expiresAtMs: 122_000 }, { ...challenge(), issuedAtMs: -1 },
    { ...challenge(), presentation: { wording: 'x', meaning: 'x', advisory: [], allow: true } },
    { ...challenge(), presentation: { wording: 'x', meaning: 'x\u202e', advisory: [] } },
    { ...challenge(), keyReference: { ...challenge().keyReference, epoch: '7' } },
  ])('rejects unimplemented or ambiguous challenge %#', input => expect(parseProtectedControlChallenge(input)).toBeNull());
});
describe('host-only confirmation broker with synthetic user-presence/key-lease ports', () => {
  it('signs only after host presentation and OS verification, and verifies the exact Ed25519 receipt', async () => {
    const f = fixture(), order: string[] = [];
    f.ports.present = async shown => { order.push('present'); expect(shown).toEqual(f.source); return true; };
    f.ports.authenticate = async () => { order.push('authenticate'); };
    f.ports.sign = async (c, bytes, signal) => { order.push('sign'); expect(signal.aborted).toBe(false); return f.signing(c, bytes, signal); };
    const result = await f.broker.confirm(f.source.id); expect(result.status).toBe('confirmed');
    if (result.status !== 'confirmed') throw new Error('fixture');
    expect(order).toEqual(['present', 'authenticate', 'sign']);
    expect(verifyProtectedControlSignature(f.source, result.receipt, f.key.publicKey)).toBe(true);
    expect(verifyProtectedControlSignature({ ...f.source, requestDigest: 'c'.repeat(64) }, result.receipt, f.key.publicKey)).toBe(false);
    expect(verifyProtectedControlSignature({ ...f.source, presentation: { ...f.source.presentation, meaning: 'A different action.' } }, result.receipt, f.key.publicKey)).toBe(false);
    expect(verifyProtectedControlSignature(f.source, result.receipt, generateKeyPairSync('ed25519').publicKey)).toBe(false);
    expect(verifyProtectedControlSignature(f.source, { ...result.receipt, approved: true } as never, f.key.publicKey)).toBe(false);
    expect((await f.broker.confirm(f.source.id)).status).toBe('refused'); expect(f.signing).toHaveBeenCalledTimes(1);
  });
  it.each(['serverOrigin', 'serverId', 'userId', 'deviceId'] as const)('will not confirm another %s', field => {
    const f = fixture(); f.source[field] = field === 'serverOrigin' ? 'https://different.test' : id(99);
    return expect(f.broker.confirm(f.source.id)).resolves.toMatchObject({ status: 'refused', code: 'invalid_challenge' });
  });
  it('rejects missing OS verification and never falls back to a renderer approval boolean', async () => {
    const f = fixture({ authenticate: async () => { throw new Error('unsupported OS authentication'); } });
    expect((await f.broker.confirm(f.source.id)).status).toBe('refused'); expect(f.signing).not.toHaveBeenCalled();
    const malformed = fixture({ authenticate: (async () => true) as never });
    expect((await malformed.broker.confirm(malformed.source.id)).status).toBe('refused'); expect(malformed.signing).not.toHaveBeenCalled();
    expect(() => createProtectedConfirmationBroker(identity, {} as never)).toThrow(/boundary/);
  });
  it('a cancelled native prompt consumes the challenge without requesting biometric verification or signing', async () => {
    const f = fixture({ present: async () => false });
    expect(await f.broker.confirm(f.source.id)).toEqual({ status: 'refused', code: 'cancelled' });
    expect((await f.broker.confirm(f.source.id)).status).toBe('refused'); expect(f.authenticate).not.toHaveBeenCalled(); expect(f.signing).not.toHaveBeenCalled();
  });
  it('does not queue simultaneous confirmation prompts', async () => {
    const wait = deferred<boolean>(), f = fixture({ present: async () => wait.promise });
    const first = f.broker.confirm(f.source.id);
    expect(await f.broker.confirm(id(99))).toEqual({ status: 'refused', code: 'busy' });
    wait.resolve(false); expect((await first).status).toBe('refused');
  });
  it('rechecks Vault/device authority after biometric success and immediately before signing', async () => {
    let current = true;
    const f = fixture({ isCurrent: async () => current, authenticate: async () => { current = false; } });
    expect((await f.broker.confirm(f.source.id)).status).toBe('refused'); expect(f.signing).not.toHaveBeenCalled();
  });
  it('drops a signed result if authority changes before the proof can be returned', async () => {
    let current = true; const f = fixture({ isCurrent: async () => current });
    f.ports.sign = async (c, message, signal) => { const result = await f.signing(c, message, signal); current = false; return result; };
    expect((await f.broker.confirm(f.source.id)).status).toBe('refused');
  });
  it('a late biometric response after disconnect/cancellation cannot sign', async () => {
    const entered = deferred<void>(), answer = deferred<void>();
    const f = fixture({ authenticate: async () => { entered.resolve(); return answer.promise; } });
    const result = f.broker.confirm(f.source.id); await entered.promise; f.broker.cancel();
    expect((await result).status).toBe('refused'); answer.resolve(); await Promise.resolve(); expect(f.signing).not.toHaveBeenCalled();
  });
  it('expired prompts and clock rollback cannot extend a confirmation', async () => {
    for (const delta of [-1, 60_000]) {
      const f = fixture(); f.ports.authenticate = async () => f.clock(delta);
      expect((await f.broker.confirm(f.source.id)).status).toBe('refused'); expect(f.signing).not.toHaveBeenCalled();
    }
  });
  it('expiry cancels a hung prompt without waiting for another request', async () => {
    vi.useFakeTimers(); const entered = deferred<void>();
    const f = fixture({ present: async () => { entered.resolve(); return new Promise(() => {}); } });
    const result = f.broker.confirm(f.source.id); await entered.promise; f.clock(60_000); await vi.advanceTimersByTimeAsync(60_000);
    expect((await result).status).toBe('refused'); expect(f.signing).not.toHaveBeenCalled();
  });
  it('freezes the host presentation, so a mutation attempt cannot sign a different command from the display', async () => {
    const f = fixture();
    f.ports.present = async c => { (c.presentation as { meaning: string }).meaning = 'Modified display object'; return true; };
    expect((await f.broker.confirm(f.source.id)).status).toBe('refused'); expect(f.signing).not.toHaveBeenCalled();
  });
  it('detaches the loaded source so its aliases cannot change the displayed and signed snapshot', async () => {
    const f = fixture(), original = structuredClone(f.source);
    f.ports.present = async c => { expect(c).toEqual(original); f.source.requestDigest = 'd'.repeat(64); return true; };
    const result = await f.broker.confirm(original.id); expect(result.status).toBe('confirmed');
    if (result.status !== 'confirmed') throw new Error('fixture');
    expect(verifyProtectedControlSignature(original, result.receipt, f.key.publicKey)).toBe(true);
    expect(verifyProtectedControlSignature(f.source, result.receipt, f.key.publicKey)).toBe(false);
  });
});
