import { describe, expect, it } from 'vitest';
import { CODE_BYTES, displayCode, inviteId, isPairingCode, newPairingCode, normalizeCode, openInvite, pairingLink, parsePairingLink, sealInvite, type InviteBox } from '@josi-ce/tunnel';

const box: InviteBox = { v: 1, server: 'c2VydmVy', site: '0'.repeat(32), relay: 'wss://relay.heyjosi.test', name: 'alice' };

describe('pairing codes', () => {
  it('carry at least 128 bits and never repeat', () => {
    expect(CODE_BYTES * 8).toBeGreaterThanOrEqual(128);
    const codes = new Set(Array.from({ length: 2000 }, newPairingCode));
    expect(codes.size).toBe(2000);
    for (const code of codes) expect(isPairingCode(code)).toBe(true);
  });

  it('survive being read aloud and retyped', () => {
    const code = newPairingCode();
    expect(normalizeCode(displayCode(code).toLowerCase())).toBe(code);
    expect(isPairingCode('K7QM4XHT')).toBe(false);
  });

  it('give the relay a box it can\'t open and an id it can\'t reverse', () => {
    const code = newPairingCode(), sealed = sealInvite(code, box);
    expect(inviteId(code)).toMatch(/^[0-9a-f]{32}$/);
    expect(sealed).not.toContain('alice');
    expect(Buffer.from(sealed, 'base64url').toString('latin1')).not.toContain('relay.heyjosi.test');
    expect(openInvite(code, sealed)).toEqual(box);
    expect(() => openInvite(newPairingCode(), sealed)).toThrow();
  });

  it('travel in the fragment of a QR link, so no request carries them', () => {
    const code = newPairingCode(), link = pairingLink('https://alice.heyjosi.test', code, box);
    expect(new URL(link).pathname + new URL(link).search).toBe('/');
    expect(parsePairingLink(link)).toEqual({ code, box });
    expect(parsePairingLink('https://alice.heyjosi.test/#josi-pair=SHORT.e30')).toBeNull();
  });
});
