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

export interface TwilioMedia {
  bytes: Buffer;
  contentType: string;
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
  // Twilio assigns SM... identifiers to SMS and MM... identifiers to MMS.
  // Treating every inbound message as SM silently discarded every real MMS.
  if (!(sid(eventId, 'SM') || sid(eventId, 'MM')) || !from || !to) return [];
  const mediaCount = Math.min(10, Math.max(0, Number(body.NumMedia ?? 0) || 0));
  const attachmentIds = Array.from({ length: mediaCount }, (_, index) => String(body[`MediaUrl${index}`] ?? '')).filter(Boolean);
  return [{ channel: 'twilio', eventId, externalIdentity: from, conversationId: from,
    text: typeof body.Body === 'string' ? body.Body.trim().slice(0, 4000) : '', replyTo: null, attachmentIds }];
}

async function boundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > maxBytes) throw new Error('Twilio media exceeds the attachment limit');
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error('Twilio media exceeds the attachment limit'); }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, size);
}

/** Fetch one authenticated MMS object without turning Twilio's supplied URL
 * into an SSRF primitive or leaking Basic auth across its CDN redirect. */
export async function fetchTwilioMedia(args: { credentials: Record<string, string>; mediaUrl: string;
  maxBytes: number; fetchImpl?: typeof fetch }): Promise<TwilioMedia> {
  const credentials = twilioCredentials(args.credentials);
  let url: URL;
  try { url = new URL(args.mediaUrl); } catch { throw new Error('Twilio supplied an invalid media URL'); }
  const expected = new RegExp(`^/2010-04-01/Accounts/${credentials.accountSid}/Messages/(?:SM|MM)[0-9a-fA-F]{32}/Media/ME[0-9a-fA-F]{32}$`);
  if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.username || url.password
    || url.search || url.hash || !expected.test(url.pathname)) throw new Error('Twilio supplied an untrusted media URL');
  const authHeader = `Basic ${Buffer.from(`${credentials.accountSid}:${credentials.authToken}`).toString('base64')}`;
  const first = await (args.fetchImpl ?? fetch)(url, { headers: { Authorization: authHeader }, redirect: 'manual' });
  let response = first;
  if ([301, 302, 303, 307, 308].includes(first.status)) {
    const location = first.headers.get('location');
    if (!location) throw new Error('Twilio media redirect was incomplete');
    const redirected = new URL(location, url);
    if (redirected.protocol !== 'https:' || redirected.hostname !== 'mms.twiliocdn.com'
      || redirected.username || redirected.password) throw new Error('Twilio media redirect was untrusted');
    // Do not forward the Account SID/Auth Token to the CDN.
    response = await (args.fetchImpl ?? fetch)(redirected, { redirect: 'error' });
  }
  if (!response.ok) throw new Error(`Twilio media download failed (${response.status})`);
  const contentType = (response.headers.get('content-type') ?? 'application/octet-stream').split(';', 1)[0].trim().toLowerCase();
  const bytes = await boundedBody(response, args.maxBytes);
  if (!bytes.length) throw new Error('Twilio media was empty');
  return { bytes, contentType };
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
    Method: 'POST', StatusCallback: args.statusCallback, StatusCallbackMethod: 'POST' });
  for (const event of ['initiated', 'ringing', 'answered', 'completed']) body.append('StatusCallbackEvent', event);
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
