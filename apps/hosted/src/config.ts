// Every setting comes from the environment and is checked once, at boot, so a
// missing value stops the service with a list instead of failing a customer's
// request later. Values are never printed, only names.
import { fromB64url } from '@josi-ce/tunnel';
import { assertTestKey } from './stripe.js';

export interface Config {
  production: boolean;
  port: number;
  publicOrigin: string;
  domain: string;
  /** Header holding the visitor's address when a proxy sits in front. */
  clientIpHeader: string | null;
  accountDataKey: Uint8Array;
  stateSigningKey: Uint8Array;
  noisePrivateKey: Uint8Array;
  grantPrivateKey: Uint8Array;
  relayUrl: string;
  stripe: { secretKey: string; webhookSecret: string; prices: { connect: string; connectAi: string; topUp10: string; topUp20: string } };
  openai: { apiKey: string; baseUrl: string };
  google: { clientId: string; clientSecret: string; redirectUri: string };
  mail: { transport: 'console' | 'smtp'; from: string; smtpUrl: string | null };
  ai: { includedMicros: number; maxOutputTokens: number; imageTokens: number; maxBodyBytes: number; reservationTtlMs: number; upstreamTimeoutMs: number };
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) { super(`Can't start:\n  ${problems.join('\n  ')}`); }
}

export function decodeKey(value: string): Uint8Array {
  const bytes = /^[0-9a-f]{64}$/i.test(value) ? Buffer.from(value, 'hex') : fromB64url(value);
  if (bytes.length !== 32) throw new Error('not 32 bytes');
  return new Uint8Array(bytes);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const need = (name: string): string => { const value = env[name]?.trim(); if (!value) problems.push(`${name} is required`); return value ?? ''; };
  const key = (name: string): Uint8Array => {
    const value = need(name);
    if (!value) return new Uint8Array(32);
    try { return decodeKey(value); } catch { problems.push(`${name} must be 32 bytes, as base64url or hex`); return new Uint8Array(32); }
  };
  const number = (name: string, fallback: number, check: (n: number) => boolean = n => n > 0): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || !check(value)) { problems.push(`${name} has a value that can't be used`); return fallback; }
    return value;
  };
  const url = (name: string, fallback?: string): string => {
    const value = env[name]?.trim() || fallback || need(name);
    if (value) try { new URL(value); } catch { problems.push(`${name} must be a URL`); }
    return value.replace(/\/$/, '');
  };

  const httpUrl = (name: string): string => {
    const value = url(name);
    if (value && !/^https?:\/\//.test(value)) problems.push(`${name} must begin https://`);
    return value;
  };

  const production = env.NODE_ENV === 'production';
  need('DATABASE_URL');
  const publicOrigin = url('PUBLIC_ORIGIN', 'https://heyjosi.com');
  const stripeKey = need('STRIPE_SECRET_KEY');
  if (stripeKey) try { assertTestKey(stripeKey); } catch (error) { problems.push((error as Error).message); }
  const webhookSecret = need('STRIPE_WEBHOOK_SECRET');
  if (webhookSecret && !webhookSecret.startsWith('whsec_')) problems.push('STRIPE_WEBHOOK_SECRET must begin whsec_');
  const transport = (env.MAIL_TRANSPORT?.trim() || 'console') as Config['mail']['transport'];
  if (transport !== 'console' && transport !== 'smtp') problems.push('MAIL_TRANSPORT must be console or smtp');
  // The console mailer prints sign-in links, which is for a laptop only.
  if (transport === 'console' && production) problems.push('MAIL_TRANSPORT=console prints sign-in links to the logs, so it isn\'t allowed in production');
  const smtpUrl = transport === 'smtp' ? need('SMTP_URL') : null;
  const config: Config = {
    production,
    port: number('PORT', 8080, n => Number.isInteger(n) && n > 0 && n < 65536),
    publicOrigin,
    domain: env.PUBLIC_DOMAIN?.trim() || (publicOrigin ? new URL(publicOrigin).hostname : 'heyjosi.com'),
    clientIpHeader: env.CLIENT_IP_HEADER?.trim().toLowerCase() || null,
    accountDataKey: key('ACCOUNT_DATA_KEY'),
    stateSigningKey: key('STATE_SIGNING_KEY'),
    noisePrivateKey: key('HOSTED_NOISE_PRIVATE_KEY'),
    grantPrivateKey: key('RELAY_GRANT_PRIVATE_KEY'),
    relayUrl: httpUrl('RELAY_URL'),
    stripe: {
      secretKey: stripeKey, webhookSecret,
      prices: { connect: need('STRIPE_PRICE_CONNECT'), connectAi: need('STRIPE_PRICE_CONNECT_AI'), topUp10: need('STRIPE_PRICE_TOPUP_10'), topUp20: need('STRIPE_PRICE_TOPUP_20') },
    },
    openai: { apiKey: need('OPENAI_API_KEY'), baseUrl: url('OPENAI_BASE_URL', 'https://api.openai.com/v1') },
    google: { clientId: need('GOOGLE_CLIENT_ID'), clientSecret: need('GOOGLE_CLIENT_SECRET'), redirectUri: `${publicOrigin}/oauth/google/callback` },
    mail: { transport, from: env.MAIL_FROM?.trim() || 'Hey Josi <hello@heyjosi.com>', smtpUrl },
    ai: {
      includedMicros: Math.round(number('AI_INCLUDED_USD', 12, n => n >= 0) * 1_000_000),
      maxOutputTokens: number('AI_MAX_OUTPUT_TOKENS', 16_384, n => Number.isInteger(n) && n > 0),
      imageTokens: number('AI_IMAGE_TOKENS', 40_000, n => Number.isInteger(n) && n > 0),
      maxBodyBytes: number('AI_MAX_BODY_BYTES', 4 * 1024 * 1024, n => Number.isInteger(n) && n > 0),
      reservationTtlMs: number('AI_RESERVATION_TTL_SECONDS', 900, n => Number.isInteger(n) && n > 0) * 1000,
      upstreamTimeoutMs: number('AI_UPSTREAM_TIMEOUT_SECONDS', 600, n => Number.isInteger(n) && n > 0) * 1000,
    },
  };
  // A sweep must not close a reservation while its call can still be running.
  if (config.ai.upstreamTimeoutMs >= config.ai.reservationTtlMs) problems.push('AI_UPSTREAM_TIMEOUT_SECONDS must be shorter than AI_RESERVATION_TTL_SECONDS');
  if (problems.length) throw new ConfigError(problems);
  return config;
}
