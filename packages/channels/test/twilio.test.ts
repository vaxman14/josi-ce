import twilio from 'twilio';
import { describe, expect, it, vi } from 'vitest';
import {
  fetchTwilioMedia, normalizeTwilioSms, probeTwilio, sendTwilioSms, startTwilioCall,
  verifyTwilioSignature,
} from '../src/twilio.js';

const credentials = {
  accountSid: `AC${'1'.repeat(32)}`, authToken: 'secret-auth-token-with-enough-length',
  messagingServiceSid: `MG${'2'.repeat(32)}`, phoneNumber: '+19517177772',
};

describe('Twilio channel boundary', () => {
  it('validates the provider signature against the exact public URL and all form fields', () => {
    const url = 'https://josi.example/channels/twilio/webhook';
    const params = { From: '+19515149294', To: credentials.phoneNumber, Body: 'hello' };
    const signature = twilio.getExpectedTwilioSignature(credentials.authToken, url, params);
    expect(verifyTwilioSignature(credentials.authToken, signature, url, params)).toBe(true);
    expect(verifyTwilioSignature(credentials.authToken, signature, `${url}?changed=1`, params)).toBe(false);
    expect(verifyTwilioSignature(credentials.authToken, signature, url, { ...params, Body: 'changed' })).toBe(false);
  });

  it('normalizes a bounded SMS without trusting malformed identities', () => {
    const messageSid = `SM${'3'.repeat(32)}`;
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages/${messageSid}/Media/ME${'4'.repeat(32)}`;
    expect(normalizeTwilioSms({ MessageSid: messageSid, From: '+19515149294', To: credentials.phoneNumber,
      Body: '  hi Josi  ', NumMedia: '1', MediaSid0: `ME${'4'.repeat(32)}`, MediaUrl0: mediaUrl })).toEqual([{
      channel: 'twilio', eventId: messageSid, externalIdentity: '+19515149294', conversationId: '+19515149294',
      text: 'hi Josi', replyTo: null, attachmentIds: [mediaUrl],
    }]);
    expect(normalizeTwilioSms({ MessageSid: 'bad', From: '9515149294', To: credentials.phoneNumber })).toEqual([]);
  });

  it('accepts a real MM-prefixed MMS and retains only its authenticated media URL', () => {
    const messageSid = `MM${'3'.repeat(32)}`;
    const mediaSid = `ME${'4'.repeat(32)}`;
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages/${messageSid}/Media/${mediaSid}`;
    expect(normalizeTwilioSms({ MessageSid: messageSid, From: '+19515149294', To: credentials.phoneNumber,
      Body: 'What is it?', NumMedia: '1', MediaSid0: mediaSid, MediaUrl0: mediaUrl })[0]).toMatchObject({
      eventId: messageSid, text: 'What is it?', attachmentIds: [mediaUrl],
    });
  });

  it('downloads bounded Twilio media without leaking credentials to the CDN', async () => {
    const messageSid = `MM${'3'.repeat(32)}`; const mediaSid = `ME${'4'.repeat(32)}`;
    const mediaUrl = `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages/${messageSid}/Media/${mediaSid}`;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('https://api.twilio.com/')) {
        expect(new Headers(init?.headers).get('authorization')).toMatch(/^Basic /);
        return new Response(null, { status: 307, headers: { location: 'https://mms.twiliocdn.com/safe-object' } });
      }
      expect(url).toBe('https://mms.twiliocdn.com/safe-object');
      expect(new Headers(init?.headers).has('authorization')).toBe(false);
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), { status: 200,
        headers: { 'content-type': 'image/png', 'content-length': '4' } });
    }) as unknown as typeof fetch;
    await expect(fetchTwilioMedia({ credentials, mediaUrl, maxBytes: 1024, fetchImpl })).resolves.toMatchObject({ contentType: 'image/png' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await expect(fetchTwilioMedia({ credentials, mediaUrl: 'https://evil.example/image', maxBytes: 1024, fetchImpl })).rejects.toThrow(/untrusted/);
  });

  it('proves account, owned number, capabilities, and messaging service', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/Accounts/') && url.endsWith('.json') && !url.includes('IncomingPhoneNumbers'))
        return new Response(JSON.stringify({ friendly_name: 'Roman' }), { status: 200 });
      if (url.includes('IncomingPhoneNumbers')) return new Response(JSON.stringify({ incoming_phone_numbers: [{ sid: `PN${'5'.repeat(32)}`, capabilities: { sms: true, voice: true } }] }), { status: 200 });
      if (url.endsWith('/PhoneNumbers?PageSize=1000')) return new Response(JSON.stringify({ phone_numbers: [{ sid: `PN${'5'.repeat(32)}`, phone_number: credentials.phoneNumber }] }), { status: 200 });
      return new Response(JSON.stringify({ sid: credentials.messagingServiceSid }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(probeTwilio(credentials, fetchImpl)).resolves.toMatchObject({ accountName: 'Roman', sms: true, voice: true });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('sends SMS and starts calls with operator-owned Twilio credentials', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); const body = String(init?.body ?? '');
      if (url.endsWith('/Messages.json')) {
        expect(body).toContain('MessagingServiceSid='); expect(body).toContain('To=%2B19515149294');
        return new Response(JSON.stringify({ sid: `SM${'6'.repeat(32)}` }), { status: 201 });
      }
      expect(url).toMatch(/\/Calls\.json$/); expect(body).toContain('From=%2B19517177772');
      for (const event of ['initiated', 'ringing', 'answered', 'completed']) expect(body).toContain(`StatusCallbackEvent=${event}`);
      return new Response(JSON.stringify({ sid: `CA${'7'.repeat(32)}` }), { status: 201 });
    }) as unknown as typeof fetch;
    await expect(sendTwilioSms({ credentials, to: '+19515149294', text: 'hi', statusCallback: 'https://josi.test/status', fetchImpl }))
      .resolves.toBe(`SM${'6'.repeat(32)}`);
    await expect(startTwilioCall({ credentials, to: '+19515149294', voiceUrl: 'https://josi.test/voice', statusCallback: 'https://josi.test/call-status', fetchImpl }))
      .resolves.toBe(`CA${'7'.repeat(32)}`);
  });
});
