// What every part of the service is handed. Tests build one of these with a
// PGlite database, a fake fetch and a fake peer transport, so nothing reaches
// the network and the clock can be moved.
import type { Db } from '@josi-ce/core';
import { staticKeyFrom, toB64url, webSocketTransport, type StaticKey, type Transport } from '@josi-ce/tunnel';
import type { Config } from './config.js';
import { deriveKey } from './crypto.js';
import type { Mailer } from './mailer.js';
import { StripeClient } from './stripe.js';

/** Fields are ids, counts and status codes. Nothing a customer wrote or a
 * provider issued belongs here. */
export type Logger = (event: string, fields?: Record<string, string | number | boolean | null>) => void;

export interface Deps {
  db: Db;
  config: Config;
  mailer: Mailer;
  fetch?: typeof fetch;
  log?: Logger;
  now?: () => number;
  peerTransport?: (url: string) => Promise<Transport>;
}

export interface Ctx {
  db: Db;
  config: Config;
  mailer: Mailer;
  fetch: typeof fetch;
  log: Logger;
  now(): number;
  /** ISO text, because both drivers accept it for a timestamptz parameter. */
  at(offsetMs?: number): string;
  noiseKey: StaticKey;
  hostedPublic: string;
  peerTransport(url: string): Promise<Transport>;
  stripe: StripeClient;
  csrfKey: Buffer;
  oauthKey: Buffer;
  rateKey: Buffer;
}

const jsonLog: Logger = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

export function createContext(deps: Deps): Ctx {
  const fetchImpl = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  const noiseKey = staticKeyFrom(deps.config.noisePrivateKey);
  return {
    db: deps.db, config: deps.config, mailer: deps.mailer, fetch: fetchImpl, log: deps.log ?? jsonLog, now,
    at: (offsetMs = 0) => new Date(now() + offsetMs).toISOString(),
    noiseKey, hostedPublic: toB64url(noiseKey.publicKey),
    peerTransport: deps.peerTransport ?? (url => webSocketTransport(url, { relay: true, timeoutMs: 10_000 })),
    stripe: new StripeClient(deps.config.stripe.secretKey, fetchImpl),
    csrfKey: deriveKey(deps.config.stateSigningKey, 'csrf'),
    oauthKey: deriveKey(deps.config.stateSigningKey, 'oauth-state'),
    rateKey: deriveKey(deps.config.stateSigningKey, 'rate-buckets'),
  };
}
