// Stripe over plain fetch, test mode only. This service must never be able to
// touch live money, so the refusals are here at the bottom, not in a caller.
import { createHmac } from 'node:crypto';
import { HttpError } from './errors.js';
import { safeEqual } from './crypto.js';

const API = 'https://api.stripe.com/v1';
const TOLERANCE_SECONDS = 300;

export function assertTestKey(key: string): void {
  if (!/^(sk|rk)_test_/.test(key)) throw new Error('STRIPE_SECRET_KEY must begin sk_test_ or rk_test_. Live keys are refused.');
}

type Params = Record<string, unknown>;

/** Stripe wants form encoding with brackets for nesting. */
export function formEncode(params: Params, prefix = '', out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object') formEncode(value as Params, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export class StripeClient {
  constructor(private readonly key: string, private readonly fetchImpl: typeof fetch) { assertTestKey(key); }

  private async call<T>(method: string, path: string, params?: Params): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.key}`, ...(params ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      ...(params ? { body: formEncode(params).toString() } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => null) as (T & { livemode?: boolean }) | null;
    if (!res.ok || !body) throw new HttpError(502, 'Billing is having trouble right now. Try again in a minute.', `stripe_${res.status}`);
    if (body.livemode === true) throw new Error('Stripe answered with a live object. Refusing it.');
    return body;
  }

  post<T>(path: string, params: Params): Promise<T> { return this.call('POST', path, params); }
  get<T>(path: string): Promise<T> { return this.call('GET', path); }
  delete<T>(path: string): Promise<T> { return this.call('DELETE', path); }
}

export interface StripeEvent { id: string; type: string; livemode: boolean; created: number; data: { object: Record<string, unknown> } }

/** The header is `t=<seconds>,v1=<hex>`, with several v1 during a secret roll.
 * The refusal for a live event comes after the signature, so only Stripe can
 * learn how we answer one. */
export function verifyWebhook(raw: Buffer, header: string | undefined, secret: string, nowMs: number): StripeEvent {
  const parts = (header ?? '').split(',').map(part => part.trim().split('='));
  const timestamp = Number(parts.find(([key]) => key === 't')?.[1]);
  const signatures = parts.filter(([key]) => key === 'v1').map(([, value]) => value ?? '');
  if (!Number.isInteger(timestamp) || !signatures.length) throw new HttpError(400, 'Bad signature.');
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(raw).digest('hex');
  if (!signatures.some(signature => safeEqual(signature, expected))) throw new HttpError(400, 'Bad signature.');
  if (Math.abs(nowMs / 1000 - timestamp) > TOLERANCE_SECONDS) throw new HttpError(400, 'Signature too old.');
  const event = JSON.parse(raw.toString('utf8')) as StripeEvent;
  if (event.livemode !== false) throw new HttpError(400, 'Live events are refused.');
  return event;
}
