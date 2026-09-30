import twilio from 'twilio';
import type { NormalizedMessage } from './shared.js';

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  messagingServiceSid: string;
  phoneNumber: string;
}

export interface TwilioProbe {
  accountName: string | null;
  numberSid: string;
  sms: boolean;
  voice: boolean;
}

const sid = (value: string, prefix: string) => new RegExp(`^${prefix}[0-9a-fA-F]{32}$`).test(value);
export const normalizeE164 = (value: string): string | null => /^\+[1-9][0-9]{7,14}$/.test(value.trim()) ? value.trim() : null;

export function twilioCredentials(value: Record<string, string>): TwilioCredentials {
  const result = {
    accountSid: value.accountSid?.trim(), authToken: value.authToken?.trim(),
    messagingServiceSid: value.messagingServiceSid?.trim(), phoneNumber: value.phoneNumber?.trim(),
  };
  if (!sid(result.accountSid, 'AC') || result.authToken.length < 20
    || !sid(result.messagingServiceSid, 'MG') || !normalizeE164(result.phoneNumber)) {
    throw new Error('Provide a valid Account SID, Auth Token, Messaging Service SID, and E.164 phone number');
  }
  return result;
}

function auth(credentials: TwilioCredentials): string {
  return `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`;
}

async function responseJson(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, init);
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(`Twilio rejected the request (${response.status})`);
  return body;
}

export async function probeTwilio(raw: Record<string, string>, fetchImpl: typeof fetch = fetch): Promise<TwilioProbe> {
  const credentials = twilioCredentials(raw);
  const headers = { Authorization: auth(credentials) };
  const account = await responseJson(fetchImpl,
    `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}.json`, { headers });
  const numbers = await responseJson(fetchImpl,
    `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(credentials.phoneNumber)}&PageSize=2`, { headers });
  const number = Array.isArray(numbers.incoming_phone_numbers) ? numbers.incoming_phone_numbers[0] as Record<string, unknown> | undefined : undefined;
  if (!number || typeof number.sid !== 'string') throw new Error('That Twilio account does not own the configured number');
  const capabilities = number.capabilities as Record<string, unknown> | undefined;
  const service = await responseJson(fetchImpl,
    `https://messaging.twilio.com/v1/Services/${credentials.messagingServiceSid}`, { headers });
  if (service.sid !== credentials.messagingServiceSid) throw new Error('The Messaging Service is unavailable');
  const members = await responseJson(fetchImpl,
    `https://messaging.twilio.com/v1/Services/${credentials.messagingServiceSid}/PhoneNumbers?PageSize=1000`, { headers });
  const member = Array.isArray(members.phone_numbers) && members.phone_numbers.some((item) => {
    const value = item as Record<string, unknown>;
    return value.sid === number.sid || value.phone_number === credentials.phoneNumber;
  });
  if (!member) throw new Error('The configured number is not attached to that Messaging Service');
  return { accountName: typeof account.friendly_name === 'string' ? account.friendly_name : null,
    numberSid: number.sid, sms: capabilities?.sms === true, voice: capabilities?.voice === true };
}

export function verifyTwilioSignature(authToken: string, signature: string | undefined,
  url: string, params: Record<string, string>): boolean {
  if (!signature || !authToken) return false;
  try { return twilio.validateRequest(authToken, signature, url, params); } catch { return false; }
}

export function normalizeTwilioSms(body: Record<string, unknown>): NormalizedMessage[] {
  const eventId = typeof body.MessageSid === 'string' ? body.MessageSid : '';
  const from = typeof body.From === 'string' ? normalizeE164(body.From) : null;
  const to = typeof body.To === 'string' ? normalizeE164(body.To) : null;
  if (!sid(eventId, 'SM') || !from || !to) return [];
  const mediaCount = Math.min(10, Math.max(0, Number(body.NumMedia ?? 0) || 0));
  const attachmentIds = Array.from({ length: mediaCount }, (_, index) => String(body[`MediaSid${index}`] ?? body[`MediaUrl${index}`] ?? '')).filter(Boolean);
  return [{ channel: 'twilio', eventId, externalIdentity: from, conversationId: from,
    text: typeof body.Body === 'string' ? body.Body.trim().slice(0, 4000) : '', replyTo: null, attachmentIds }];
}

export async function sendTwilioSms(args: { credentials: Record<string, string>; to: string; text: string;
  statusCallback: string; fetchImpl?: typeof fetch }): Promise<string> {
  const credentials = twilioCredentials(args.credentials);
  const body = new URLSearchParams({ To: args.to, Body: args.text,
    MessagingServiceSid: credentials.messagingServiceSid, StatusCallback: args.statusCallback });
  const result = await responseJson(args.fetchImpl ?? fetch,
    `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Messages.json`, {
      method: 'POST', headers: { Authorization: auth(credentials), 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
  if (typeof result.sid !== 'string') throw new Error('Twilio did not return a message identifier');
  return result.sid;
}

export async function startTwilioCall(args: { credentials: Record<string, string>; to: string;
  voiceUrl: string; statusCallback: string; fetchImpl?: typeof fetch }): Promise<string> {
  const credentials = twilioCredentials(args.credentials);
  const body = new URLSearchParams({ To: args.to, From: credentials.phoneNumber, Url: args.voiceUrl,
    Method: 'POST', StatusCallback: args.statusCallback, StatusCallbackMethod: 'POST',
    StatusCallbackEvent: 'initiated ringing answered completed' });
  const result = await responseJson(args.fetchImpl ?? fetch,
    `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/Calls.json`, {
      method: 'POST', headers: { Authorization: auth(credentials), 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
  if (typeof result.sid !== 'string') throw new Error('Twilio did not return a call identifier');
  return result.sid;
}

export async function configureTwilioNumber(args: { credentials: Record<string, string>; smsUrl: string;
  voiceUrl: string; fetchImpl?: typeof fetch }): Promise<void> {
  const credentials = twilioCredentials(args.credentials);
  const probe = await probeTwilio({ ...credentials }, args.fetchImpl ?? fetch);
  const body = new URLSearchParams({ SmsUrl: args.smsUrl, SmsMethod: 'POST', VoiceUrl: args.voiceUrl, VoiceMethod: 'POST' });
  await responseJson(args.fetchImpl ?? fetch,
    `https://api.twilio.com/2010-04-01/Accounts/${credentials.accountSid}/IncomingPhoneNumbers/${probe.numberSid}.json`, {
      method: 'POST', headers: { Authorization: auth(credentials), 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
  await responseJson(args.fetchImpl ?? fetch,
    `https://messaging.twilio.com/v1/Services/${credentials.messagingServiceSid}`, {
      method: 'POST', headers: { Authorization: auth(credentials), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ UseInboundWebhookOnNumber: 'true' }),
    });
}
