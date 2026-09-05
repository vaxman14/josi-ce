import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeSignal, verifySignalBridge } from '../src/signal.js';
import { normalizeSlack, verifySlackSignature } from '../src/slack.js';
import { normalizeWhatsApp, verifyWhatsAppChallenge, verifyWhatsAppSignature } from '../src/whatsapp.js';

describe('external messaging platforms', () => {
  it('verifies and normalizes WhatsApp Cloud API messages', () => {
    const raw = Buffer.from('{"safe":true}'); const secret = 'secret';
    expect(verifyWhatsAppSignature(raw, `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`, secret)).toBe(true);
    expect(verifyWhatsAppChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'v', 'hub.challenge': '123' }, 'v')).toBe('123');
    expect(normalizeWhatsApp({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '15551234567', type: 'text', text: { body: 'hello' } }] } }] }] })[0]).toMatchObject({ eventId: 'wamid.1', externalIdentity: '15551234567', text: 'hello' });
  });

  it('rejects stale Slack signatures and ignores bot echoes', () => {
    const raw = Buffer.from('{}'); const now = 2_000_000_000_000; const timestamp = String(Math.floor(now / 1000));
    const signature = `v0=${createHmac('sha256', 'secret').update(`v0:${timestamp}:`).update(raw).digest('hex')}`;
    expect(verifySlackSignature(raw, timestamp, signature, 'secret', now)).toBe(true);
    expect(verifySlackSignature(raw, String(Number(timestamp) - 301), signature, 'secret', now)).toBe(false);
    expect(normalizeSlack({ type: 'event_callback', event_id: 'Ev1', team_id: 'T1', event: { type: 'message', user: 'U1', channel: 'D1', text: 'hello' } })[0]).toMatchObject({ externalIdentity: 'T1:U1', conversationId: 'T1:D1' });
    expect(normalizeSlack({ type: 'event_callback', event_id: 'Ev2', event: { type: 'message', bot_id: 'B1' } })).toEqual([]);
  });

  it('requires an authenticated Signal bridge and normalizes envelopes', () => {
    const raw = Buffer.from('{}'); const signature = createHmac('sha256', 'secret').update(raw).digest('hex');
    expect(verifySignalBridge(raw, signature, 'secret')).toBe(true);
    expect(normalizeSignal({ envelope: { sourceNumber: '+15551234567', timestamp: 123, dataMessage: { message: 'hello' } } })[0]).toMatchObject({ eventId: '+15551234567:123', text: 'hello' });
  });
});
