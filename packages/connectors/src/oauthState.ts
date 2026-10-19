// The OAuth handshake, server-side.
//
// Ported from the engine, whose reasoning is kept because it was learned the
// hard way: a state that is merely SIGNED is unguessable but replayable —
// anyone who captures a callback URL can replay it until the TTL runs out. So
// the handshake is STORED and CONSUMED, and a second use is a rejection rather
// than a second connection.
//
// What the callback is allowed to believe comes from this row, never from the
// query string. Including which user is connecting.
//
// CE difference: the engine's callback landed on a different hostname from the
// session cookie, so the session binding was best-effort. CE is one origin, so
// the cookie IS present and the binding is enforced — a callback for someone
// else's handshake is refused even if the state leaked.
import { createHash, randomBytes } from 'node:crypto';
import { deleteVaultSlot, openCredentialPayload, storeVaultCredentialPayload, isVaultCredentialReference,
  VaultError, VaultLockedError, type Db, type MasterKey } from '@josi-ce/core';
import type { Provider } from './capabilities.js';
import { requireConnectorVault } from './credentialVault.js';

export interface StartedHandshake {
  state: string;
  verifier: string;
  challenge: string;
}

export interface ResolvedHandshake {
  userId: string;
  sessionId: string | null;
  provider: Provider;
  capabilities: string[];
  scopes: string;
  verifier: string | null;
  returnPath: string;
  targetConnectionId: string | null;
}

export type HandshakeFailure =
  | 'unknown'          // no such state: forged, or already purged
  | 'consumed'         // replay
  | 'expired'
  | 'wrong_provider'   // a google state redeemed at the microsoft callback
  | 'session_mismatch';

const DEFAULT_TTL_SECONDS = 600;

/** RFC 7636 S256. Both providers accept it for confidential clients and it
 * costs nothing to send. */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url'); // 64 chars, within 43..128
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Only relative, single-slash paths inside the app.
 *
 * A return path is attacker-influenced input in the general case, and a
 * callback that will redirect anywhere is an open redirect with extra steps. */
export function safeReturnPath(raw: unknown, fallback = '/app/connections'): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return fallback;
  if (raw.includes('\\') || raw.includes('\n') || raw.includes('\r')) return fallback;
  return raw.length > 512 ? fallback : raw;
}

interface StateRow {
  id: string;
  user_id: string;
  session_id: string | null;
  provider: Provider;
  capabilities: string[];
  scopes: string;
  verifier_enc: string | null;
  return_path: string;
  target_connection_id: string | null;
  expires_at: string;
  consumed_at: string | null;
}

export interface StateStore {
  start(args: {
    userId: string;
    sessionId?: string | null;
    provider: Provider;
    capabilities: string[];
    scopes: string;
    returnPath?: string;
    targetConnectionId?: string | null;
    ttlSeconds?: number;
  }): Promise<StartedHandshake>;

  consume(args: {
    state: string;
    provider: Provider;
    sessionId?: string | null;
  }): Promise<{ ok: true; handshake: ResolvedHandshake } | { ok: false; reason: HandshakeFailure }>;

  purge(olderThanSeconds?: number): Promise<number>;
}

export function createStateStore(db: Db, key: MasterKey | null): StateStore {
  const transaction = <T>(work: (tx: Db) => Promise<T>): Promise<T> => {
    if (!db.transaction) throw new VaultError('OAuth handshakes require transactions');
    return db.transaction(work);
  };
  const slot = (state: string) => createHash('sha256').update(state).digest('hex');
  const removeVerifier = async (tx: Db, row: Pick<StateRow, 'id' | 'user_id'>) => {
    await deleteVaultSlot(tx, { ownerUserId: row.user_id, service: 'oauth.pkce', slot: slot(row.id), actorUserId: row.user_id });
  };
  return {
    async start(args) {
      if (!key) throw new VaultLockedError('The Vault key is required to start a connection.');
      return transaction(async tx => {
        await requireConnectorVault(tx);
        const { verifier, challenge } = createPkcePair();
        // 32 random bytes. The state is the primary key, so being unguessable is
        // the whole defence against someone minting one.
        const state = randomBytes(32).toString('base64url');
        const reference = await storeVaultCredentialPayload(tx, key, { ownerUserId: args.userId, kind: 'oauth_token', service: 'oauth.pkce', slot: slot(state),
          label: 'Temporary connection verifier', payload: { verifier } });
        await tx.query(
          `insert into oauth_states
             (id, user_id, session_id, provider, capabilities, scopes, verifier_enc, return_path,
              target_connection_id, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(secs => $10))`,
          [
            state,
            args.userId,
            args.sessionId ?? null,
            args.provider,
            args.capabilities,
            args.scopes,
            reference,
            safeReturnPath(args.returnPath),
            args.targetConnectionId ?? null,
            args.ttlSeconds ?? DEFAULT_TTL_SECONDS,
          ],
        );
        return { state, verifier, challenge };
      });
    },

    async consume(args) {
      if (!args.state || args.state.length > 512) return { ok: false, reason: 'unknown' };
      return transaction(async tx => {
        await tx.query('select id from vault_state where id=true for share');
        const rows = await tx.query<StateRow>(`select * from oauth_states where id = $1 for update`, [args.state]);
        const row = rows[0];
        if (!row) return { ok: false, reason: 'unknown' };
        if (row.consumed_at) return { ok: false, reason: 'consumed' };
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await removeVerifier(tx, row);
          await tx.query('update oauth_states set verifier_enc=null where id=$1', [row.id]);
          return { ok: false, reason: 'expired' };
        }
        // A state minted for Google must not be redeemable at the Microsoft
        // callback, whatever an attacker persuades the browser to fetch.
        if (row.provider !== args.provider) return { ok: false, reason: 'wrong_provider' };
        // Enforced in CE: one origin means the cookie is here. A leaked state
        // cannot be redeemed from somebody else's browser.
        if (row.session_id && args.sessionId !== row.session_id) {
          return { ok: false, reason: 'session_mismatch' };
        }

        await requireConnectorVault(tx);
        if (!key) throw new VaultLockedError('The Vault key is required to finish a connection.');
        if (!row.verifier_enc) throw new VaultError('The connection verifier is unavailable; start connecting again.');
        const payload = await openCredentialPayload<{ verifier: string }>(tx, key, { ownerUserId: row.user_id, service: 'oauth.pkce', slot: slot(row.id), stored: row.verifier_enc });
        if (typeof payload.verifier !== 'string' || !/^[A-Za-z0-9_-]{43,128}$/.test(payload.verifier)) throw new VaultError('The connection verifier is invalid; start connecting again.');
        if (!isVaultCredentialReference(row.verifier_enc)) {
          // Import old in-flight handshakes under the same lock/box checks as new
          // ones. Consumption removes the temporary canonical item in this TX.
          await storeVaultCredentialPayload(tx, key, { ownerUserId: row.user_id, kind: 'oauth_token', service: 'oauth.pkce', slot: slot(row.id),
            label: 'Temporary connection verifier', payload });
        }

        // Resolve before the conditional claim. A locked/unreadable Vault leaves
        // this handshake unconsumed; no callback may proceed without PKCE.
        const claimed = await tx.query<{ id: string }>(
          `update oauth_states set consumed_at = now(),verifier_enc=null where id = $1 and consumed_at is null and expires_at>now() returning id`,
          [args.state],
        );
        if (!claimed.length) return { ok: false, reason: 'consumed' };

        await removeVerifier(tx, row);

        return {
          ok: true,
          handshake: {
            userId: row.user_id,
            sessionId: row.session_id,
            provider: row.provider,
            capabilities: row.capabilities ?? [],
            scopes: row.scopes,
            verifier: payload.verifier,
            returnPath: safeReturnPath(row.return_path),
            targetConnectionId: row.target_connection_id,
          },
        };
      });
    },

    async purge(olderThanSeconds = 3600) {
      return transaction(async tx => {
        await tx.query('select id from vault_state where id=true for share');
        // Erase temporary credentials as soon as they expire, independently of
        // the retained state's diagnostic grace period. Deletion works locked.
        const spent = await tx.query<Pick<StateRow, 'id' | 'user_id'>>(
          `update oauth_states set verifier_enc=null where verifier_enc is not null and (consumed_at is not null or expires_at<=now()) returning id,user_id`,
        );
        for (const row of spent) await removeVerifier(tx, row);
        const rows = await tx.query<{ id: string }>(
          `delete from oauth_states
           where (consumed_at is not null and consumed_at < now() - make_interval(secs => $1))
              or expires_at < now() - make_interval(secs => $1)
           returning id`,
          [olderThanSeconds],
        );
        return rows.length;
      });
    },
  };
}
