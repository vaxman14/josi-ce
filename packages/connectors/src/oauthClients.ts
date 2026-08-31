// The operator's own OAuth application.
//
// M28: CE ships with no client of its own. Each installation registers its own
// Google/Microsoft application, exactly as other self-hosted products require,
// and the secret is sealed with the installation master key before storage.
//
// There is no environment variable for these and no default. A CE image that
// carried a client secret would be handing every installation the same
// credential, and the first person to extract it could impersonate all of them.
import { appendEvent, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import type { Provider } from './capabilities.js';
import type { OAuthClient } from './providers.js';

export interface ClientStatus {
  provider: Provider;
  configured: boolean;
  clientId: string | null;
  redirectUri: string | null;
  updatedAt: string | null;
}

/** What an administrator may see: that it is set, and the two values that are
 * not secret. Never the secret, in any form. */
export async function clientStatuses(db: Db): Promise<ClientStatus[]> {
  const rows = await db.query<{
    provider: Provider; client_id: string; redirect_uri: string; updated_at: string;
  }>(`select provider, client_id, redirect_uri, updated_at from oauth_clients`);
  const found = new Map(rows.map((r) => [r.provider, r]));
  return (['google', 'microsoft'] as Provider[]).map((provider) => {
    const row = found.get(provider);
    return {
      provider,
      configured: !!row,
      // The client id is public by design — it travels in the authorize URL.
      clientId: row?.client_id ?? null,
      redirectUri: row?.redirect_uri ?? null,
      updatedAt: row?.updated_at ?? null,
    };
  });
}

export async function saveClient(
  db: Db,
  key: MasterKey,
  args: {
    provider: Provider;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    actorUserId: string;
  },
): Promise<void> {
  await db.query(
    `insert into oauth_clients (provider, client_id, client_secret_enc, redirect_uri, configured_by)
     values ($1, $2, $3, $4, $5)
     on conflict (provider) do update set
       client_id = excluded.client_id,
       client_secret_enc = excluded.client_secret_enc,
       redirect_uri = excluded.redirect_uri,
       configured_by = excluded.configured_by`,
    [args.provider, args.clientId, seal(key, { clientSecret: args.clientSecret }), args.redirectUri, args.actorUserId],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'connector.client_configured',
    // The provider and the fact it changed. Not the id, not the secret, not
    // the URI — the audit log answers "who changed what kind of thing, when".
    payload: { provider: args.provider },
  });
}

export async function deleteClient(
  db: Db,
  args: { provider: Provider; actorUserId: string },
): Promise<void> {
  await db.query(`delete from oauth_clients where provider = $1`, [args.provider]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: 'connector.client_removed',
    payload: { provider: args.provider },
  });
}

export class NoClientError extends Error {}

/** Opens the client for use. The only place the secret is decrypted. */
export async function loadClient(db: Db, key: MasterKey, provider: Provider): Promise<OAuthClient> {
  const [row] = await db.query<{ client_id: string; client_secret_enc: string; redirect_uri: string }>(
    `select client_id, client_secret_enc, redirect_uri from oauth_clients where provider = $1`,
    [provider],
  );
  if (!row) {
    throw new NoClientError(
      `no ${provider} application is configured for this installation — an administrator sets that up first`,
    );
  }
  return {
    provider,
    clientId: row.client_id,
    clientSecret: openSealed<{ clientSecret: string }>(key, row.client_secret_enc).clientSecret,
    redirectUri: row.redirect_uri,
  };
}
