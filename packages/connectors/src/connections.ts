// Stored connections: tokens, capability grants, and health.
//
// Tokens are sealed with the installation master key before they touch
// PostgreSQL and are opened only here, at the moment of use. Nothing in this
// file returns a token to a caller, and nothing writes one to the audit log —
// `appendEvent` would refuse the payload key anyway, which is the backstop
// working rather than a reason not to be careful.
import { appendEvent, json, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import {
  CAPABILITIES, capabilitySpec, grantedCapabilities, capabilityState, effectiveCapability,
  type CapabilityState, type Provider,
} from './capabilities.js';
import {
  ConnectorError, refreshTokens, type ErrorCategory, type FetchOptions, type OAuthClient, type TokenSet,
} from './providers.js';

export interface ConnectionRow {
  id: string;
  owner_user_id: string;
  provider: Provider;
  account_email: string | null;
  provider_account_id: string | null;
  granted_scopes: string;
  secrets_enc: string | null;
  status: 'active' | 'needs_reconnect' | 'revoked';
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: ErrorCategory | null;
  token_expires_at: string | null;
  created_at: string;
  // Present since 0001, unused by every OAuth provider (their identity lives
  // in account_email / provider_account_id). Nextcloud is the first provider
  // to use it: { serverUrl, username } — neither secret, both needed to build
  // a WebDAV request, and both worth showing the owner without unsealing
  // anything. The app password itself never appears here; it is sealed into
  // `secrets_enc` exactly like an OAuth refresh token.
  meta: { serverUrl?: string; username?: string } | null;
}

interface SealedTokens {
  accessToken: string;
  refreshToken: string | null;
}

/** What a Nextcloud connection seals instead of an OAuth token pair. A
 * WebDAV app password does not expire and is not refreshed — there is no
 * token lifecycle here, only a credential that is valid until its owner
 * revokes it in their own Nextcloud account, at which point every request
 * fails with 401 and the connection is marked unhealthy exactly as an
 * expired OAuth token would be. */
export interface NextcloudCredentials {
  serverUrl: string;
  username: string;
  appPassword: string;
}

/** Writes or replaces a connection after a successful handshake.
 *
 * Scope accumulation is deliberate. Incremental authorization means the second
 * consent covers only what was newly asked for, and a provider that answers
 * with just those scopes must not narrow a connection that already had more. */
export async function upsertConnection(
  db: Db,
  key: MasterKey,
  args: {
    ownerUserId: string;
    provider: Provider;
    tokens: TokenSet;
    accountEmail: string | null;
    providerAccountId: string | null;
    /** Which capabilities this consent was collected for. */
    requestedCapabilities: string[];
    /** The owner started this handshake by pressing an unavailable capability
     * switch on an existing connection. A normal connection stays off. */
    enableRequestedCapabilities?: boolean;
  },
): Promise<ConnectionRow> {
  const [existing] = await db.query<ConnectionRow>(
    `select * from connections where owner_user_id = $1 and provider = $2`,
    [args.ownerUserId, args.provider],
  );

  const merged = new Set([
    ...(existing?.granted_scopes ?? '').split(/\s+/).filter(Boolean),
    ...args.tokens.grantedScopes.split(/\s+/).filter(Boolean),
  ]);
  const grantedScopes = [...merged].join(' ');

  // Google does not return a refresh token on a re-auth unless it feels like
  // it. Losing the one we already hold would silently turn a working
  // connection into one that dies at the next access-token expiry.
  let refreshToken = args.tokens.refreshToken;
  if (!refreshToken && existing?.secrets_enc) {
    try {
      refreshToken = openSealed<SealedTokens>(key, existing.secrets_enc).refreshToken;
    } catch {
      refreshToken = null;
    }
  }

  const sealed = seal(key, { accessToken: args.tokens.accessToken, refreshToken } satisfies SealedTokens);
  const expiresAt = args.tokens.expiresIn
    ? new Date(Date.now() + args.tokens.expiresIn * 1000).toISOString()
    : null;

  const rows = await db.query<ConnectionRow>(
    `insert into connections
       (owner_user_id, provider, account_email, provider_account_id, granted_scopes, secrets_enc,
        status, last_check_at, last_check_ok, last_error_category, token_expires_at)
     values ($1, $2, $3, $4, $5, $6, 'active', now(), true, null, $7)
     on conflict (owner_user_id, provider) do update set
       account_email = excluded.account_email,
       provider_account_id = excluded.provider_account_id,
       granted_scopes = excluded.granted_scopes,
       secrets_enc = excluded.secrets_enc,
       status = 'active',
       last_check_at = now(), last_check_ok = true, last_error_category = null,
       token_expires_at = excluded.token_expires_at
     returning *`,
    [
      args.ownerUserId, args.provider, args.accountEmail, args.providerAccountId,
      grantedScopes, sealed, expiresAt,
    ],
  );
  const connection = rows[0];

  // Record which capabilities the provider now covers. A normal first connect
  // leaves the default read bundle off: consent to CONNECT is not consent to
  // ACT. An explicitly requested write/storage capability is different: the
  // owner pressed "Approve at provider" for that exact switch, so returning
  // from a successful incremental-consent trip must finish turning it on.
  // Otherwise the UI sends them through consent and then leaves the switch off,
  // which was the live Calendar-write failure reproduced on 2026-09-04.
  const covered = grantedCapabilities(args.provider, grantedScopes);
  for (const capability of covered) {
    const spec = capabilitySpec(capability);
    const enableAfterExplicitConsent = args.enableRequestedCapabilities === true
      && args.requestedCapabilities.includes(capability)
      && (spec?.kind === 'write' || spec?.connectOptIn === true);
    await db.query(
      `insert into connection_capabilities (connection_id, capability, enabled, scopes_granted_at)
       values ($1, $2, $3, now())
       on conflict (connection_id, capability) do update set
         scopes_granted_at = now(),
         enabled = connection_capabilities.enabled or excluded.enabled`,
      [connection.id, capability, enableAfterExplicitConsent],
    );
  }

  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'connection.authorized',
    subjectType: 'connection',
    subjectId: connection.id,
    // Which capabilities, never which mailbox and never a token.
    payload: { provider: args.provider, capabilities: covered, requested: args.requestedCapabilities },
  });

  return connection;
}

export async function getConnection(db: Db, connectionId: string): Promise<ConnectionRow | null> {
  const rows = await db.query<ConnectionRow>(`select * from connections where id = $1`, [connectionId]);
  return rows[0] ?? null;
}

export async function connectionFor(
  db: Db,
  args: { ownerUserId: string; provider: Provider },
): Promise<ConnectionRow | null> {
  const rows = await db.query<ConnectionRow>(
    `select * from connections where owner_user_id = $1 and provider = $2`,
    [args.ownerUserId, args.provider],
  );
  return rows[0] ?? null;
}

// ------------------------------------------------------------ capabilities

export interface CapabilityView {
  key: string;
  label: string;
  kind: 'read' | 'write';
  consequence?: string;
  state: CapabilityState;
  /** True when switching this on needs another trip through the provider. */
  needsConsent: boolean;
  adminNote: string | null;
}

async function adminPolicy(db: Db): Promise<Map<string, { allowed: boolean; note: string | null }>> {
  const rows = await db.query<{ capability: string; allowed: boolean; note: string | null }>(
    `select capability, allowed, note from admin_capability_policy`,
  );
  return new Map(rows.map((r) => [r.capability, { allowed: r.allowed, note: r.note }]));
}

/** Every capability for a provider, with the state each one is actually in. */
export async function capabilityViews(
  db: Db,
  args: { connection: ConnectionRow | null; provider: Provider },
): Promise<CapabilityView[]> {
  const policy = await adminPolicy(db);
  const grants = new Map<string, { enabled: boolean; scopes_granted_at: string | null }>();
  if (args.connection) {
    const rows = await db.query<{ capability: string; enabled: boolean; scopes_granted_at: string | null }>(
      `select capability, enabled, scopes_granted_at from connection_capabilities where connection_id = $1`,
      [args.connection.id],
    );
    for (const row of rows) grants.set(row.capability, row);
  }

  return CAPABILITIES.filter((spec) => spec.provider === args.provider).map((spec) => {
    const grant = grants.get(spec.key);
    const providerGranted = !!grant?.scopes_granted_at;
    const admin = policy.get(spec.key);
    const adminAllows = admin?.allowed ?? true;
    const state = capabilityState({
      providerGranted,
      adminAllows,
      userEnabled: grant?.enabled ?? false,
    });
    return {
      key: spec.key,
      label: spec.label,
      kind: spec.kind,
      consequence: spec.consequence,
      state,
      needsConsent: !providerGranted,
      adminNote: state === 'blocked_by_admin' ? (admin?.note ?? null) : null,
    };
  });
}

/** May this happen, right now?
 *
 * The one question the rest of the product asks before touching a provider.
 * Everything else in this file exists to make this answer trustworthy. */
export async function can(
  db: Db,
  args: { ownerUserId: string; capability: string },
): Promise<{ allowed: boolean; state: CapabilityState }> {
  const spec = capabilitySpec(args.capability);
  if (!spec) return { allowed: false, state: 'needs_consent' };

  const connection = await connectionFor(db, { ownerUserId: args.ownerUserId, provider: spec.provider });
  if (!connection || connection.status === 'revoked') {
    return { allowed: false, state: 'needs_consent' };
  }

  const [grant] = await db.query<{ enabled: boolean; scopes_granted_at: string | null }>(
    `select enabled, scopes_granted_at from connection_capabilities
     where connection_id = $1 and capability = $2`,
    [connection.id, args.capability],
  );
  const [policy] = await db.query<{ allowed: boolean }>(
    `select allowed from admin_capability_policy where capability = $1`,
    [args.capability],
  );

  const inputs = {
    providerGranted: !!grant?.scopes_granted_at,
    adminAllows: policy?.allowed ?? true,
    userEnabled: grant?.enabled ?? false,
  };
  return { allowed: effectiveCapability(inputs), state: capabilityState(inputs) };
}

export class CapabilityError extends Error {
  constructor(readonly state: CapabilityState, message: string) {
    super(message);
  }
}

/** Turn a capability on or off for a connection.
 *
 * Enabling something the provider never granted is refused rather than stored
 * as a wish: a row saying "enabled" for a scope we do not hold would make the
 * Connections page lie. The caller sends the person back through consent. */
export async function setCapability(
  db: Db,
  args: { connection: ConnectionRow; capability: string; enabled: boolean; actorUserId: string },
): Promise<CapabilityView[]> {
  const spec = capabilitySpec(args.capability);
  if (!spec || spec.provider !== args.connection.provider) {
    throw new CapabilityError('needs_consent', 'no such capability for this connection');
  }

  if (args.enabled) {
    const [grant] = await db.query<{ scopes_granted_at: string | null }>(
      `select scopes_granted_at from connection_capabilities where connection_id = $1 and capability = $2`,
      [args.connection.id, args.capability],
    );
    if (!grant?.scopes_granted_at) {
      // M32. This is the "enabling send forces re-consent" path.
      throw new CapabilityError(
        'needs_consent',
        'that permission has not been granted by the provider yet — reconnect and approve it',
      );
    }
    const [policy] = await db.query<{ allowed: boolean }>(
      `select allowed from admin_capability_policy where capability = $1`,
      [args.capability],
    );
    if (policy && !policy.allowed) {
      throw new CapabilityError(
        'blocked_by_admin',
        'an administrator has switched this off for the whole installation',
      );
    }
  }

  await db.query(
    `insert into connection_capabilities (connection_id, capability, enabled)
     values ($1, $2, $3)
     on conflict (connection_id, capability) do update set enabled = excluded.enabled`,
    [args.connection.id, args.capability, args.enabled],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: args.enabled ? 'connection.capability_enabled' : 'connection.capability_disabled',
    subjectType: 'connection',
    subjectId: args.connection.id,
    payload: { capability: args.capability },
  });

  return capabilityViews(db, { connection: args.connection, provider: args.connection.provider });
}

// ----------------------------------------------------------------- tokens

/** An access token for use right now, refreshed if it is about to expire.
 *
 * Returned to the caller and never stored anywhere else, never logged, and
 * never put in a response body. The 60-second margin is because a token that
 * expires mid-request is a failure the user sees. */
export async function accessTokenFor(
  db: Db,
  key: MasterKey,
  args: { connection: ConnectionRow; client: OAuthClient },
  opts: FetchOptions = {},
): Promise<string> {
  if (!args.connection.secrets_enc) {
    throw new ConnectorError('this connection has no stored credentials', { category: 'revoked', revoked: true });
  }
  const tokens = openSealed<SealedTokens>(key, args.connection.secrets_enc);

  const expiresAt = args.connection.token_expires_at
    ? new Date(args.connection.token_expires_at).getTime()
    : 0;
  const stillValid = expiresAt > Date.now() + 60_000;
  if (stillValid) return tokens.accessToken;

  if (!tokens.refreshToken) {
    await markUnhealthy(db, args.connection.id, 'revoked');
    throw new ConnectorError('this connection needs to be reconnected', { category: 'revoked', revoked: true });
  }

  try {
    const refreshed = await refreshTokens(
      args.client,
      { refreshToken: tokens.refreshToken, scopes: args.connection.granted_scopes },
      opts,
    );
    const sealed = seal(key, {
      accessToken: refreshed.accessToken,
      // Google does not reissue one; keep what we have.
      refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
    } satisfies SealedTokens);
    await db.query(
      `update connections set secrets_enc = $2, token_expires_at = $3,
         status = 'active', last_check_at = now(), last_check_ok = true, last_error_category = null
       where id = $1`,
      [
        args.connection.id,
        sealed,
        refreshed.expiresIn ? new Date(Date.now() + refreshed.expiresIn * 1000).toISOString() : null,
      ],
    );
    return refreshed.accessToken;
  } catch (err) {
    const category = err instanceof ConnectorError ? err.category : 'provider_error';
    await markUnhealthy(db, args.connection.id, category);
    throw err;
  }
}

// -------------------------------------------------------------- nextcloud

/** Writes or replaces a Nextcloud connection.
 *
 * Deliberately its own function rather than a branch inside `upsertConnection`
 * — there is no OAuth handshake, no `TokenSet`, no scope accumulation to do,
 * and no identity call to make (the server URL and username the person typed
 * ARE the identity, unlike an OAuth account_email discovered after the fact).
 * `may_map_cloud` / `may_index` govern it exactly like every other cloud
 * provider once connected; only the connecting step differs. */
export async function connectNextcloud(
  db: Db,
  key: MasterKey,
  args: { ownerUserId: string; serverUrl: string; username: string; appPassword: string },
): Promise<ConnectionRow> {
  const sealed = seal(key, {
    serverUrl: args.serverUrl, username: args.username, appPassword: args.appPassword,
  } satisfies NextcloudCredentials);

  const rows = await db.query<ConnectionRow>(
    `insert into connections
       (owner_user_id, provider, account_email, provider_account_id, granted_scopes, secrets_enc,
        status, last_check_at, last_check_ok, last_error_category, meta)
     values ($1, 'nextcloud', $2, null, '', $3, 'active', now(), true, null, $4)
     on conflict (owner_user_id, provider) do update set
       account_email = excluded.account_email,
       secrets_enc = excluded.secrets_enc,
       status = 'active',
       last_check_at = now(), last_check_ok = true, last_error_category = null,
       meta = excluded.meta
     returning *`,
    [
      args.ownerUserId, args.username, sealed,
      json({ serverUrl: args.serverUrl, username: args.username }),
    ],
  );
  const connection = rows[0];

  // The one capability this provider has, granted immediately — there is no
  // incremental-scope dance to model: the app password the person generated
  // either works for WebDAV or it does not, and there is nothing narrower to
  // ask Nextcloud for. Still OFF by default (M32's "consent to connect is not
  // consent to act" applies here exactly as it does to an OAuth grant).
  await db.query(
    `insert into connection_capabilities (connection_id, capability, enabled, scopes_granted_at)
     values ($1, 'nextcloud.files.read', false, now())
     on conflict (connection_id, capability) do update set scopes_granted_at = now()`,
    [connection.id],
  );

  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'connection.authorized',
    subjectType: 'connection',
    subjectId: connection.id,
    // The server URL is the owner's own infrastructure, not a secret account
    // identity — still left out of the audit payload, matching every other
    // provider's "which capabilities, never which account" rule.
    payload: { provider: 'nextcloud', capabilities: ['nextcloud.files.read'] },
  });

  return connection;
}

/** The WebDAV credential for use right now.
 *
 * Same shape as `accessTokenFor`'s contract — returned to the caller and
 * never stored anywhere else — but there is no refresh step: an app password
 * is valid until its owner revokes it, and a revoked one fails at first use
 * with 401, handled by the caller exactly like an expired OAuth token. */
export async function nextcloudCredentialsFor(
  key: MasterKey,
  connection: ConnectionRow,
): Promise<NextcloudCredentials> {
  if (!connection.secrets_enc) {
    throw new ConnectorError('this connection has no stored credentials', { category: 'revoked', revoked: true });
  }
  return openSealed<NextcloudCredentials>(key, connection.secrets_enc);
}

export async function markUnhealthy(db: Db, connectionId: string, category: ErrorCategory): Promise<void> {
  const needsReconnect = category === 'revoked' || category === 'insufficient_scope';
  await db.query(
    `update connections set
       status = case when $2 then 'needs_reconnect' else status end,
       last_check_at = now(), last_check_ok = false, last_error_category = $3
     where id = $1`,
    [connectionId, needsReconnect, category],
  );
  await appendEvent(db, {
    actor: 'system',
    kind: 'connection.unhealthy',
    subjectType: 'connection',
    subjectId: connectionId,
    // A category, not the provider's words.
    payload: { category },
  });
}

/** Delete our copy. Capability grants go with it — a reconnect starts from
 * "read only, nothing enabled", which is where consent should start. */
export async function deleteConnection(
  db: Db,
  args: { connectionId: string; actorUserId: string; actor: 'user' | 'super_admin' },
): Promise<void> {
  await db.query(`delete from connections where id = $1`, [args.connectionId]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: args.actor,
    kind: 'connection.removed',
    subjectType: 'connection',
    subjectId: args.connectionId,
  });
}
