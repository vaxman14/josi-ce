// Google through the shared Hey Josi client.
//
// The client secret stays on heyjosi.com, so anything that needs it goes there:
// starting consent, and refreshing a token. Each is a sealed call (see rpc.ts in
// packages/tunnel), so the refresh token is readable only by the hosted process,
// in memory, for the length of one request. It keeps none of them. The tokens
// themselves live here, in this server's Vault, like any other connection's.
import { resolveDataPath, type Db } from '@josi-ce/core';
import { fromB64url, rpcCall, staticKeyFrom, type HostedCall, type HostedReply } from '@josi-ce/tunnel';
import { openKeyStore, type KeyStore } from '@josi-ce/tunnel/node';
import { join } from 'node:path';
import { ConnectorError, type FetchOptions, type OAuthClient, type TokenSet } from './providers.js';

export const NOISE_KEYS = 'noise-keys';
/** Which application a connection's refresh token belongs to. */
export const HEY_JOSI_CLIENT = 'hey-josi';

export interface StoredNoiseKeys { current: string; previous?: string | null; previousUntil?: string | null }

export interface HostedLink { hosted_url: string | null; hosted_public: string | null; plan: string; server_id: string | null }

export async function hostedLink(db: Db): Promise<HostedLink | null> {
  const [row] = await db.query<HostedLink>('select hosted_url, hosted_public, plan, server_id from hey_josi_link where id = true');
  return row?.hosted_url && row.hosted_public ? row : null;
}

/** Google is on offer through Hey Josi when this server is linked to a plan that has it. */
export async function sharedGoogleAvailable(db: Db): Promise<boolean> {
  const link = await hostedLink(db);
  return !!link && link.plan !== 'free';
}

let store: Promise<KeyStore> | null = null;
export function serverKeyStore(): Promise<KeyStore> {
  store ??= openKeyStore({ fallbackDir: join(resolveDataPath('/data'), 'keys') });
  return store;
}
/** Tests supply their own. */
export function useKeyStore(next: KeyStore | null): void { store = next ? Promise.resolve(next) : null; }

export async function hostedCall<T>(db: Db, call: HostedCall, opts: FetchOptions = {}): Promise<HostedReply<T>> {
  const link = await hostedLink(db);
  if (!link) throw new ConnectorError('this server is not linked to a Hey Josi account', { category: 'provider_error' });
  const raw = await (await serverKeyStore()).get(NOISE_KEYS);
  if (!raw) throw new ConnectorError('this server has no relay key', { category: 'provider_error' });
  const keys = JSON.parse(raw) as StoredNoiseKeys;
  try {
    return await rpcCall<T>({ url: link.hosted_url!, key: staticKeyFrom(fromB64url(keys.current)), hostedPublic: fromB64url(link.hosted_public!), call,
      fetchImpl: opts.fetchImpl, timeoutMs: opts.timeoutMs });
  } catch {
    throw new ConnectorError('could not reach heyjosi.com', { category: 'network' });
  }
}

/** The stand-in for an `oauth_clients` row. No secret: that's the point. */
export function heyJosiClient(): OAuthClient {
  return { provider: 'google', clientId: HEY_JOSI_CLIENT, clientSecret: '', redirectUri: '' };
}
export const isHeyJosiClient = (client: OAuthClient): boolean => client.clientId === HEY_JOSI_CLIENT;

export async function brokeredRefresh(db: Db, args: { refreshToken: string; scopes: string }, opts: FetchOptions = {}): Promise<TokenSet> {
  const reply = await hostedCall<{ accessToken: string; expiresIn: number | null; scope: string | null }>(db, { op: 'google.refresh', refreshToken: args.refreshToken, scopes: args.scopes }, opts);
  if (!reply.ok) {
    const revoked = reply.error === 'invalid_grant';
    throw new ConnectorError(revoked ? 'the provider refused the request (revoked)' : 'heyjosi.com refused the refresh', { category: revoked ? 'revoked' : 'provider_error', revoked });
  }
  return { accessToken: reply.accessToken, refreshToken: null, expiresIn: reply.expiresIn, grantedScopes: reply.scope ?? args.scopes };
}
