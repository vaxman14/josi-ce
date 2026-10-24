import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deviceConsentMessage, type DeviceConsentChallenge } from '@josi-ce/protocol';
import { startNativeDeviceConsent, windowsConsentAvailable } from '../src/http/nativeDeviceConsent.js';

// Item 29: on Windows the server starts the Josi app in its consent mode and
// talks to it over framed stdin/stdout. A node script stands in for the app;
// the framing, the digest check and the state machine are the real ones.
const windows = process.platform === 'win32';
const saved = { helper: process.env.JOSI_DEVICE_CONSENT_HELPER, args: process.env.JOSI_DEVICE_CONSENT_HELPER_ARGS, session: process.env.SESSIONNAME };
afterEach(() => {
  for (const [key, value] of [['JOSI_DEVICE_CONSENT_HELPER', saved.helper], ['JOSI_DEVICE_CONSENT_HELPER_ARGS', saved.args], ['SESSIONNAME', saved.session]] as const) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function challenge(): DeviceConsentChallenge {
  const now = Date.now();
  return { schemaVersion: 1, id: randomUUID(), nonce: randomBytes(32).toString('base64url'), serverOrigin: 'https://josi.example.test',
    serverId: randomUUID(), userId: randomUUID(), deviceId: randomUUID(), enrollmentId: randomUUID(), requestDigest: 'a'.repeat(64),
    authorityEpoch: 1, issuedAtMs: now - 1000, expiresAtMs: now + 60_000,
    presentation: { wording: 'Enroll THEBUTT for protected administrator confirmations.', meaning: 'Server: https://josi.example.test', advisory: ['Approve on the server computer.'] } };
}
function helper(script: string) {
  const dir = mkdtempSync(join(tmpdir(), 'josi-consent-'));
  const file = join(dir, 'helper.mjs');
  writeFileSync(file, script);
  process.env.JOSI_DEVICE_CONSENT_HELPER = process.execPath;
  process.env.JOSI_DEVICE_CONSENT_HELPER_ARGS = JSON.stringify([file]);
  process.env.SESSIONNAME = 'Console';
}
// The stand-in reads one frame, answers "ready", then "approved" (or whatever
// the script decides), exactly as Josi.exe --device-consent does.
const script = (decide: string) => `
import { createHash } from 'node:crypto';
const chunks = []; let size = -1;
process.stdin.on('data', part => { chunks.push(part); const all = Buffer.concat(chunks); if (size < 0 && all.length >= 4) size = all.readUInt32BE(0); if (size >= 0 && all.length >= size + 4) go(JSON.parse(all.subarray(4, size + 4).toString('utf8'))); });
function frame(item) { const body = Buffer.from(JSON.stringify(item)); const head = Buffer.alloc(4); head.writeUInt32BE(body.length); process.stdout.write(Buffer.concat([head, body])); }
function go(request) {
  const message = Buffer.from(request.message, 'base64');
  const digest = createHash('sha256').update(message).digest('hex');
  if (digest !== request.challengeDigest) process.exit(3);
  frame({ schemaVersion: 1, id: request.id, challengeDigest: digest, state: 'ready' });
  ${decide}
}
setTimeout(() => process.exit(0), 20_000);
`;
describe.skipIf(!windows)('Windows device consent helper', () => {
  it('is unavailable without a configured helper or an interactive session', async () => {
    delete process.env.JOSI_DEVICE_CONSENT_HELPER;
    expect(await windowsConsentAvailable()).toBe(false);
    process.env.JOSI_DEVICE_CONSENT_HELPER = process.execPath; process.env.JOSI_DEVICE_CONSENT_HELPER_ARGS = '["x"]';
    delete process.env.SESSIONNAME;
    expect(await windowsConsentAvailable()).toBe(false);
    process.env.SESSIONNAME = 'Console';
    expect(await windowsConsentAvailable()).toBe(true);
  });
  it('reaches approved only after the helper approves the exact request, and consumes it once', async () => {
    helper(script(`setTimeout(() => { frame({ schemaVersion: 1, id: request.id, challengeDigest: digest, state: 'approved' }); }, 300);`));
    const value = challenge(), controller = new AbortController();
    const consent = await startNativeDeviceConsent(value, controller.signal);
    expect(consent.challengeDigest).toBe(createHash('sha256').update(deviceConsentMessage(value)).digest('hex'));
    expect(consent.status()).toBe('waiting');
    await new Promise(resolve => setTimeout(resolve, 900));
    expect(consent.status()).toBe('approved');
    consent.consume(value);
    expect(() => consent.consume(value)).toThrow();
    consent.close();
  });
  it('treats a helper that exits without approving as cancelled', async () => {
    helper(script(`setTimeout(() => process.exit(1), 200);`));
    const consent = await startNativeDeviceConsent(challenge(), new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(consent.status()).toBe('cancelled');
    expect(() => consent.consume(challenge())).toThrow();
  });
  it('refuses a helper that answers for another request', async () => {
    helper(script(`setTimeout(() => { frame({ schemaVersion: 1, id: '00000000-0000-4000-8000-000000000000', challengeDigest: digest, state: 'approved' }); }, 200);`));
    const consent = await startNativeDeviceConsent(challenge(), new AbortController().signal);
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(consent.status()).toBe('cancelled');
  });
});
