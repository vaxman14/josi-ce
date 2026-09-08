// GitHub, Netlify, Vercel and Supabase.
//
// WHY THIS IS ITS OWN FILE AND NOT A FIFTH ENTRY IN `capabilities.ts`
//
// Everything in `connections.ts` is an OAuth grant: an application the operator
// registered, a consent screen that names scopes, a token the provider will
// refresh and can narrow. None of that is true here. These four are connected
// with a personal access token that the person mints in their own account and
// pastes in, and — Netlify, Vercel and fine-grained GitHub tokens — the provider
// will not tell us afterwards what it covers.
//
// That difference is not cosmetic, so it is not hidden behind a shared
// abstraction. Three consequences follow and each one is visible in the code
// below rather than buried:
//
//   1. LEAST PRIVILEGE IS ADVICE, NOT ENFORCEMENT. CE cannot ask Netlify for a
//      read-only token; Netlify does not have one. So `minimumPermissions` is
//      shown to the person BEFORE the field they paste into, and where a
//      provider's token really is account-wide the copy says so plainly instead
//      of implying a scope we did not request.
//   2. THE TOKEN IS THE WHOLE CREDENTIAL. There is no refresh, no expiry we
//      control, and no narrowing. It is sealed with the installation master key
//      the moment it arrives and opened only inside a probe.
//   3. CONNECTING IS NOT PRESET. There is no default, no environment variable,
//      no seeded row and no installation-wide fallback. A service is connected
//      when a person connected it, and at no other time. `SERVICES` below is a
//      catalogue of what CAN be connected — reading it grants nothing.
//
// These are deliberately NOT model providers (packages/llm), NOT messaging
// channels (packages/channels), and NOT a general outbound HTTP capability. The
// assistant gets nothing from this file; it stores a credential and reports
// whether the provider accepts it.
import { appendEvent, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import type { ErrorCategory } from './providers.js';

export const DEV_SERVICES = ['github', 'netlify', 'vercel', 'supabase'] as const;
export type DevService = (typeof DEV_SERVICES)[number];

export function isDevService(value: string): value is DevService {
  return (DEV_SERVICES as readonly string[]).includes(value);
}

/** One card on the Developer services page. */
export interface DevServiceSpec {
  key: DevService;
  label: string;
  /** One sentence: what connecting this is FOR. */
  purpose: string;
  /** The exact host every request for this service goes to. Nothing else is
   * reachable — see `devServiceFetch`. A single pinned host is the whole SSRF
   * story for these four: no part of the credential form is a URL. */
  apiHost: string;
  /** Where the person goes to mint the token, so the guided setup is a link
   * and not a description of a menu. */
  tokenUrl: string;
  /** Numbered, in the order a person does them. */
  steps: readonly string[];
  /** The minimum the token needs, in the provider's own words. */
  minimumPermissions: readonly string[];
  /** Stated where the provider cannot scope a token, so nobody believes a
   * narrower grant was requested than actually exists. Null when the provider
   * genuinely does offer least privilege. */
  scopeCaveat: string | null;
  /** Whether the provider reports back what the token covers. Only GitHub
   * does, and only for classic tokens. */
  reportsScopes: boolean;
  /** How to take it away at the provider — the half CE cannot do for them. */
  revokeHint: string;
}

export const SERVICES: Readonly<Record<DevService, DevServiceSpec>> = {
  github: {
    key: 'github',
    label: 'GitHub',
    purpose: 'Read repositories you choose, so Josi can answer questions about code and issues you point it at.',
    apiHost: 'api.github.com',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
    steps: [
      'Open GitHub, then Settings, Developer settings, Personal access tokens, Fine-grained tokens.',
      'Choose "Generate new token" and name it something you will recognise later, such as "Josi".',
      'Under "Repository access", pick "Only select repositories" and choose the ones Josi should see. Do not choose "All repositories".',
      'Under "Permissions", grant Repository permissions: Metadata read-only, and Contents read-only. Grant nothing else.',
      'Set an expiry date. A token with no expiry is a credential nobody ever rotates.',
      'Generate the token and paste it below. GitHub shows it once.',
    ],
    minimumPermissions: [
      'Repository, Metadata: read-only (GitHub requires this for any fine-grained token)',
      'Repository, Contents: read-only',
      'Nothing under Organization permissions, and no write, admin or delete permission of any kind',
    ],
    scopeCaveat: null,
    reportsScopes: true,
    revokeHint: 'GitHub, Settings, Developer settings, Personal access tokens, then Revoke.',
  },
  netlify: {
    key: 'netlify',
    label: 'Netlify',
    purpose: 'See your Netlify sites and their deploy status.',
    apiHost: 'api.netlify.com',
    tokenUrl: 'https://app.netlify.com/user/applications',
    steps: [
      'Open Netlify, then User settings, Applications, Personal access tokens.',
      'Choose "New access token" and name it "Josi", so you can tell it apart from your own.',
      'Set the shortest expiry that suits you, then generate it.',
      'Copy the token and paste it below. Netlify shows it once.',
    ],
    minimumPermissions: [
      'Netlify personal access tokens cannot be scoped. Use a dedicated token for Josi and nothing else.',
    ],
    scopeCaveat:
      'Netlify does not offer read-only or per-site tokens. A personal access token can do anything '
      + 'your own account can do, including deleting sites. Josi only ever reads with it, but Netlify '
      + 'is not enforcing that — you are trusting this installation. Use a token created for Josi '
      + 'alone so you can revoke it without disrupting anything else.',
    reportsScopes: false,
    revokeHint: 'Netlify, User settings, Applications, then revoke the token named for Josi.',
  },
  vercel: {
    key: 'vercel',
    label: 'Vercel',
    purpose: 'See your Vercel projects and their deployment status.',
    apiHost: 'api.vercel.com',
    tokenUrl: 'https://vercel.com/account/tokens',
    steps: [
      'Open Vercel, then Account settings, Tokens.',
      'Choose "Create Token" and name it "Josi".',
      'Under Scope, select the single team or personal account Josi should see, not "All".',
      'Set an expiry rather than "No expiration".',
      'Create the token and paste it below. Vercel shows it once.',
    ],
    minimumPermissions: [
      'Scope: the one team or personal account you want Josi to see',
      'Expiry: set one. Vercel offers 1 day, 7 days, 30 days, 60 days, 90 days or a custom date',
    ],
    scopeCaveat:
      'A Vercel token is scoped to a team, not to an action: within that team it can deploy and '
      + 'delete as well as read. Scope it to one team and give it an expiry.',
    reportsScopes: false,
    revokeHint: 'Vercel, Account settings, Tokens, then delete the token named for Josi.',
  },
  supabase: {
    key: 'supabase',
    label: 'Supabase',
    purpose: 'List the Supabase projects on your account, so Josi can tell you what exists and where.',
    apiHost: 'api.supabase.com',
    tokenUrl: 'https://supabase.com/dashboard/account/tokens',
    steps: [
      'Open the Supabase dashboard, then Account, Access tokens.',
      'Choose "Generate new token" and name it "Josi".',
      'Copy the token — it begins with sbp_ — and paste it below. Supabase shows it once.',
      'Optionally add a project reference (the twenty-letter code in your project URL) so Josi checks it can reach that one project.',
    ],
    minimumPermissions: [
      'A personal access token from the Account, Access tokens page',
      'NOT a project API key. The service_role key bypasses every row-level security policy you have '
      + 'written, and Josi refuses it.',
    ],
    scopeCaveat:
      'A Supabase personal access token is account-wide: it can administer every project your account '
      + 'can. Supabase does not offer a read-only one. Create a token for Josi alone and revoke it '
      + 'when you are done.',
    reportsScopes: false,
    revokeHint: 'Supabase dashboard, Account, Access tokens, then revoke the token named for Josi.',
  },
};

// ------------------------------------------------------------- what is stored

export interface DevServiceConnectionRow {
  id: string;
  owner_user_id: string;
  service: DevService;
  credentials_enc: string;
  account_label: string | null;
  account_id: string | null;
  reported_scopes: string | null;
  project_ref: string | null;
  status: 'active' | 'needs_reconnect' | 'revoked';
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: ErrorCategory | null;
  created_at: string;
  updated_at: string;
}

/** What is sealed. One field, because one field is the whole credential. */
export interface DevServiceSecret {
  token: string;
}

/** The mask the owner sees where the token was.
 *
 * A CONSTANT, carrying no bytes of the credential — not the last four
 * characters, not the length. "Which token is this?" is answered by the account
 * label the provider gave us, which is a better answer and is not a secret. */
export const TOKEN_MASK = '••••••••••••';

// ----------------------------------------------------------------- validation

export class DevServiceInputError extends Error {}

/** The longest credential any of the four issues, with room to spare. A field
 * without a ceiling is a field somebody pastes a file into. */
const MAX_TOKEN_CHARS = 500;

/** Whitespace and control characters, written as escapes so this file has none
 * of them in it. Either one in a pasted token means the paste took something
 * it should not have. */
const NOT_IN_A_TOKEN = /[\s\u0000-\u001f\u007f]/;

/**
 * Refuses a value that cannot be the credential being asked for.
 *
 * Deliberately narrow. Two kinds of check, and nothing in between:
 *
 *   * SHAPE — empty, whitespace inside, control characters, or absurdly long.
 *     These are always wrong, for every provider, and catching them here means
 *     a mis-paste fails with a sentence instead of a 401 nobody can interpret.
 *   * THE ONE DANGEROUS CONFUSION — a Supabase `service_role` key pasted where
 *     a personal access token belongs. That key is a JWT, it bypasses every
 *     row-level security policy on the project, and pasting it here is the
 *     single most damaging mistake available on this page. It is refused by
 *     name, with an explanation.
 *
 * What is NOT checked: token prefixes as a requirement. GitHub Enterprise,
 * older Netlify tokens and Vercel's format have all changed at least once, and
 * a validator that gets ahead of a provider refuses a credential that works.
 * The guided setup says what the prefix should look like; the server does not
 * make it a rule.
 */
export function validateToken(service: DevService, raw: unknown): string {
  if (typeof raw !== 'string') throw new DevServiceInputError('a token is required');
  const token = raw.trim();
  if (!token) throw new DevServiceInputError('a token is required');
  if (token.length > MAX_TOKEN_CHARS) {
    throw new DevServiceInputError('that is too long to be an access token — check what was pasted');
  }
  if (NOT_IN_A_TOKEN.test(token)) {
    throw new DevServiceInputError(
      'that contains a space, a line break or a character a token cannot contain — paste just the token',
    );
  }

  if (service === 'supabase' && looksLikeSupabaseProjectKey(token)) {
    throw new DevServiceInputError(
      'that is a project API key, not a personal access token. A service_role key bypasses every '
      + 'row-level security policy on your project, so Josi will not store one. Generate a personal '
      + 'access token from the Supabase dashboard under Account, Access tokens instead.',
    );
  }
  return token;
}

/** A Supabase project key is a JWT: three dot-separated base64url segments
 * beginning `eyJ`. A personal access token is not, so the test is the shape
 * rather than an attempt to decode and inspect a credential we are refusing. */
export function looksLikeSupabaseProjectKey(token: string): boolean {
  return /^eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

/** Supabase's project reference: exactly the twenty lowercase letters that
 * appear in the project's own URL. Anything else — a full URL, a host, a path,
 * something with a slash in it — is refused here rather than being stored and
 * later interpolated into a request path. */
export function validateProjectRef(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new DevServiceInputError('that is not a project reference');
  const ref = raw.trim();
  if (!ref) return null;
  if (!/^[a-z]{20}$/.test(ref)) {
    throw new DevServiceInputError(
      'a Supabase project reference is twenty lowercase letters — it is the code in your project '
      + 'URL, not the whole address',
    );
  }
  return ref;
}

// -------------------------------------------------------------------- storage

/** The administrator's ceiling for one service. Deny-only: nothing in this
 * file turns a connection on, and there is no argument that could. */
export async function servicePolicy(
  db: Db,
  service: DevService,
): Promise<{ allowed: boolean; note: string | null }> {
  const [row] = await db.query<{ allowed: boolean; note: string | null }>(
    `select allowed, note from developer_service_policy where service = $1`,
    [service],
  );
  return { allowed: row?.allowed ?? true, note: row?.note ?? null };
}

export async function servicePolicies(
  db: Db,
): Promise<Map<DevService, { allowed: boolean; note: string | null }>> {
  const rows = await db.query<{ service: DevService; allowed: boolean; note: string | null }>(
    `select service, allowed, note from developer_service_policy`,
  );
  return new Map(rows.map((r) => [r.service, { allowed: r.allowed, note: r.note }]));
}

export async function devConnectionFor(
  db: Db,
  args: { ownerUserId: string; service: DevService },
): Promise<DevServiceConnectionRow | null> {
  const rows = await db.query<DevServiceConnectionRow>(
    `select * from developer_service_connections where owner_user_id = $1 and service = $2`,
    [args.ownerUserId, args.service],
  );
  return rows[0] ?? null;
}

/** By id, for the routes that take one in the path.
 *
 * A malformed id is "not found" rather than a query, the same rule
 * `resolveAccess` applies — and the routes turn the null into a 404 whether the
 * row is missing or belongs to somebody else, so the two are indistinguishable
 * from outside. */
export async function devConnectionById(
  db: Db,
  connectionId: string,
): Promise<DevServiceConnectionRow | null> {
  if (!/^[0-9a-fA-F-]{36}$/.test(connectionId)) return null;
  const rows = await db.query<DevServiceConnectionRow>(
    `select * from developer_service_connections where id = $1`,
    [connectionId],
  );
  return rows[0] ?? null;
}

export async function devConnectionsFor(
  db: Db,
  ownerUserId: string,
): Promise<DevServiceConnectionRow[]> {
  return db.query<DevServiceConnectionRow>(
    `select * from developer_service_connections where owner_user_id = $1 order by service`,
    [ownerUserId],
  );
}

/** Writes or replaces a connection after the provider has accepted the token.
 *
 * Called only from a successful probe. A credential that has not been verified
 * is never stored: an unverified row would show as "connected" and fail at the
 * first real use, which is the failure mode this whole page exists to avoid. */
export async function saveDevConnection(
  db: Db,
  key: MasterKey,
  args: {
    ownerUserId: string;
    service: DevService;
    token: string;
    accountLabel: string | null;
    accountId: string | null;
    reportedScopes: string | null;
    projectRef: string | null;
  },
): Promise<DevServiceConnectionRow> {
  const sealed = seal(key, { token: args.token } satisfies DevServiceSecret);
  const rows = await db.query<DevServiceConnectionRow>(
    `insert into developer_service_connections
       (owner_user_id, service, credentials_enc, account_label, account_id, reported_scopes,
        project_ref, status, last_check_at, last_check_ok, last_error_category)
     values ($1, $2, $3, $4, $5, $6, $7, 'active', now(), true, null)
     on conflict (owner_user_id, service) do update set
       credentials_enc = excluded.credentials_enc,
       account_label = excluded.account_label,
       account_id = excluded.account_id,
       reported_scopes = excluded.reported_scopes,
       project_ref = excluded.project_ref,
       status = 'active',
       last_check_at = now(), last_check_ok = true, last_error_category = null
     returning *`,
    [
      args.ownerUserId, args.service, sealed, args.accountLabel, args.accountId,
      args.reportedScopes, args.projectRef,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'developer_service.connected',
    subjectType: 'developer_service_connection',
    subjectId: rows[0].id,
    // Which service, and nothing else. Not the account, not the scopes, and
    // `appendEvent` would refuse a `token` key anyway — which is the backstop
    // working, not a reason to be careless here.
    payload: { service: args.service },
  });
  return rows[0];
}

/** The token, for use right now. Returned to the caller, never stored anywhere
 * else, never logged, and never put in a response body. */
export function devTokenFor(key: MasterKey, row: DevServiceConnectionRow): string {
  return openSealed<DevServiceSecret>(key, row.credentials_enc).token;
}

/** Records what the last check found.
 *
 * A refused credential becomes `needs_reconnect`, because that is what fixes
 * it. A rate limit or a provider outage leaves the status alone: the token is
 * fine and reconnecting would achieve nothing. */
export async function recordCheck(
  db: Db,
  args: { connectionId: string; ok: boolean; category?: ErrorCategory | null },
): Promise<void> {
  const needsReconnect = args.category === 'revoked'
    || args.category === 'expired'
    || args.category === 'insufficient_scope';
  await db.query(
    `update developer_service_connections set
       status = case when $2 then 'active' when $3 then 'needs_reconnect' else status end,
       last_check_at = now(), last_check_ok = $2, last_error_category = $4
     where id = $1`,
    [args.connectionId, args.ok, needsReconnect, args.ok ? null : (args.category ?? 'provider_error')],
  );
}

/** Delete our copy.
 *
 * Our copy is all CE can delete: none of the four offers an API that revokes a
 * personal access token, so the page tells the person where to finish the job.
 * Saying "disconnected" while a live token sits in somebody's GitHub settings
 * would be a half-truth, and `revokeHint` is what stops it being one. */
export async function deleteDevConnection(
  db: Db,
  args: { connectionId: string; service: DevService; actorUserId: string; actor: 'user' | 'super_admin' },
): Promise<void> {
  await db.query(`delete from developer_service_connections where id = $1`, [args.connectionId]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: args.actor,
    kind: args.actor === 'super_admin'
      ? 'developer_service.revoked_by_admin'
      : 'developer_service.disconnected',
    subjectType: 'developer_service_connection',
    subjectId: args.connectionId,
    payload: { service: args.service },
  });
}
