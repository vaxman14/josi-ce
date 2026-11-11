// Custom MCP connections: a person's own outside tool servers.
//
// WHAT THIS IS
//
// An MCP server is a web address that offers an assistant a list of tools. A
// person adds one here — as many as they like — with their own sign-in, and
// Josi may then use that server's tools in THAT PERSON'S conversations and in
// nobody else's.
//
// WHO MAY
//
// The owner of the installation (super admin) always. For members there is one
// installation-wide permission the owner sets: not allowed (the default),
// everyone, or named people. It is the same idea as a developer service, and
// like it the permission is enforced on every write and every use here, never
// by hiding a button.
//
// WHAT IS KEPT WHERE
//
//   * The address, the name and the cleaned list of tools are ordinary columns.
//   * A token, a header value, a client secret and OAuth tokens are ONE sealed
//     payload in the person's own Vault box (service `mcp`, slot = the
//     connection id). The row holds a reference to it and nothing else.
//   * Nothing in this file returns a credential to a caller outside it, except
//     as request headers handed to the client for one request.
//
// WHAT DECIDES WHETHER A TOOL ASKS FIRST
//
// Only `readOnly`, which is the server's `annotations.readOnlyHint === true`,
// together with what that tool was the first time it was seen. A tool that was
// seen NOT read-only keeps asking even if the server later relabels it, until
// the person checks the connection themselves on the settings page. A
// description can never change it.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendEvent, deleteVaultSlot, json, openCredentialPayload, storeVaultCredentialPayload,
  VaultError, VaultLockedError, type Db, type MasterKey,
} from '@josi-ce/core';
import { requireConnectorVault } from './credentialVault.js';
import { isPermissionMode, type PermissionMode } from './developerServices.js';
import {
  McpError, cleanMcpLine, mcpCallTool, mcpClose, mcpInitialize, mcpListTools,
  type McpNetOptions, type McpSession, type McpTarget, type McpToolRecord, type McpToolResult,
} from './mcpClient.js';
import {
  buildMcpAuthorizationUrl, createMcpPkce, discoverMcpOAuth, exchangeMcpOAuthCode, refreshMcpOAuthTokens,
  registerMcpOAuthClient, type McpOAuthClient, type McpOAuthMetadata, type McpOAuthTokens,
} from './mcpOAuth.js';

// ------------------------------------------------------------------- shapes

export type McpAuthKind = 'none' | 'bearer' | 'header' | 'oauth';
export const MCP_AUTH_KINDS: readonly McpAuthKind[] = Object.freeze(['none', 'bearer', 'header', 'oauth']);
export type McpStatus = 'active' | 'needs_sign_in' | 'needs_attention';

/** A ceiling, not a plan limit: enough for anybody, and a bound on a loop. */
export const MAX_MCP_CONNECTIONS_PER_PERSON = 20;

/** OAuth facts that are not secret, kept in the `oauth` column. */
export interface McpOAuthInfo extends McpOAuthMetadata {
  clientId: string;
  tokenAuth: McpOAuthClient['tokenAuth'];
  /** The redirect address this client was registered with. */
  redirectUri: string;
  /** When the access token runs out (ms since 1970), or null. */
  expiresAt: number | null;
  signedIn: boolean;
}

export interface McpConnectionRow {
  id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  url: string;
  host: string;
  auth_kind: McpAuthKind;
  auth_header: string | null;
  credentials_enc: string | null;
  oauth: Partial<McpOAuthInfo>;
  status: McpStatus;
  enabled: boolean;
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error: string | null;
  server_name: string | null;
  protocol_version: string | null;
  tools: McpToolRecord[];
  tools_fetched_at: string | null;
  tools_dropped: number;
  disabled_tools: string[];
  ask_first_names: string[];
  created_at: string;
  updated_at: string;
}

/** What is sealed. One shape per sign-in method. */
type McpSecret =
  | { token: string }
  | { value: string }
  | { clientSecret?: string | null; accessToken?: string | null; refreshToken?: string | null };

/** A refusal about what somebody typed: 400. `code` lets a screen react to
 * the one case it must (a client id is needed) without matching on words. */
export class McpInputError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

/** A refusal about who is asking or what exists: 403, 404 or 409. */
export class McpAccessError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// --------------------------------------------------------------- validation

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SLUG = /^[a-z][a-z0-9_]{0,30}[a-z0-9]$/;

export function validateMcpName(raw: unknown): string {
  const name = text(raw).replace(/\s+/g, ' ');
  if (!name) throw new McpInputError('give this server a name you will recognise later');
  if (name.length > 80) throw new McpInputError('a name can be at most 80 characters');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new McpInputError('a name cannot contain control characters');
  return name;
}

/** The short name the assistant sees, and the first half of every tool name
 * built from this connection. An identifier, so a name can never carry a
 * quote, a line break or a path into a prompt. */
export function validateMcpSlug(raw: unknown, fallbackName?: string): string {
  let slug = text(raw).toLowerCase();
  if (!slug && fallbackName) {
    slug = fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 28);
    if (!/^[a-z]/.test(slug)) slug = `server_${slug}`.slice(0, 28);
    slug = slug.replace(/_+$/, '');
    if (slug.length < 2) slug = 'server';
  }
  if (!SLUG.test(slug)) {
    throw new McpInputError(
      'the short name must be 2 to 32 lowercase letters, digits and underscores, starting with a letter — for example "notes"',
    );
  }
  return slug;
}

/** The server's address. HTTPS only: Josi will not send a sign-in over an
 * unencrypted connection, and a remote server is the only kind there is. */
export function validateMcpUrl(raw: unknown): { url: string; host: string } {
  const value = text(raw);
  if (!value) throw new McpInputError('give the server\'s address, starting with https://');
  if (value.length > 500) throw new McpInputError('that address is too long');
  let url: URL;
  try { url = new URL(value); } catch { throw new McpInputError('that is not a valid web address'); }
  if (url.protocol !== 'https:') {
    throw new McpInputError('the address must start with https://. Josi only connects to MCP servers on the web, over an encrypted connection.');
  }
  if (url.username || url.password) throw new McpInputError('put the sign-in in the fields below, not in the address');
  if (url.hash) throw new McpInputError('the address cannot contain a #fragment');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw new McpInputError('that address has no host in it');
  return { url: url.toString(), host };
}

export function validateMcpAuthKind(raw: unknown): McpAuthKind {
  const value = text(raw);
  if ((MCP_AUTH_KINDS as readonly string[]).includes(value)) return value as McpAuthKind;
  throw new McpInputError('choose how to sign in: no sign-in, a token, a named header, or sign in with the browser');
}

/** Headers the connection itself needs. A pasted value may not replace them. */
const RESERVED_HEADERS = new Set([
  'accept', 'content-type', 'content-length', 'host', 'connection', 'transfer-encoding', 'upgrade',
  'mcp-session-id', 'mcp-protocol-version', 'user-agent', 'cookie', 'te', 'trailer', 'expect',
]);

export function validateMcpHeaderName(raw: unknown): string {
  const header = text(raw);
  if (!header) throw new McpInputError('say which header carries the value, for example X-API-Key');
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(header)) throw new McpInputError('that is not a valid header name');
  if (RESERVED_HEADERS.has(header.toLowerCase())) throw new McpInputError('that header is used by the connection itself; choose another');
  return header;
}

function secretValue(raw: unknown, what: string, allowSpaces = false): string {
  const value = text(raw);
  if (!value) throw new McpInputError(`${what} is required`);
  if (value.length > 4096) throw new McpInputError(`that ${what} is too long`);
  if ((allowSpaces ? /[\u0000-\u001f\u007f]/ : /[\s\u0000-\u001f\u007f]/).test(value)) {
    throw new McpInputError(`that ${what} contains a space, a line break or a character that cannot be sent — paste just the value`);
  }
  return value;
}
export const validateMcpToken = (raw: unknown) => secretValue(raw, 'token');
export const validateMcpHeaderValue = (raw: unknown) => secretValue(raw, 'header value', true);
export function validateMcpClientId(raw: unknown): string {
  const value = secretValue(raw, 'client id');
  if (value.length > 512) throw new McpInputError('that client id is too long');
  return value;
}

// ------------------------------------------------------------------- policy

export interface McpPolicy { mode: PermissionMode; note: string | null; allowedUserIds: string[] }

export async function mcpPolicy(db: Db): Promise<McpPolicy> {
  const [row] = await db.query<{ mode: PermissionMode; note: string | null }>('select mode, note from mcp_policy where id = true');
  const named = await db.query<{ user_id: string }>('select user_id from mcp_allowed_users order by created_at');
  return { mode: row?.mode ?? 'not_allowed', note: row?.note ?? null, allowedUserIds: named.map((n) => n.user_id) };
}

/** May this person add and use MCP servers right now? The owner always; a
 * member only as the policy says. Asked at every write and every use. */
export async function mcpPermitted(db: Db, userId: string): Promise<boolean> {
  if (!UUID.test(userId)) return false;
  const rows = await db.query(
    `select 1 from users u where u.id = $1 and u.status = 'active' and (
       u.role = 'super_admin'
       or exists (select 1 from mcp_policy p where p.id = true and (p.mode = 'everyone'
         or (p.mode = 'specific_users' and exists (select 1 from mcp_allowed_users a where a.user_id = u.id))))
     )`, [userId]);
  return rows.length === 1;
}

async function requirePermission(db: Db, userId: string): Promise<void> {
  if (await mcpPermitted(db, userId)) return;
  const [policy] = await db.query<{ note: string | null }>('select note from mcp_policy where id = true');
  throw new McpAccessError(403, policy?.note
    ? `The owner of this Josi has not allowed MCP servers for your account. ${policy.note}`
    : 'The owner of this Josi has not allowed MCP servers for your account.');
}
export { requirePermission as requireMcpPermission };

export async function setMcpPolicy(db: Db, args: {
  actorUserId: string; mode: unknown; note?: unknown; userIds?: unknown;
}): Promise<McpPolicy> {
  if (!isPermissionMode(args.mode)) throw new McpInputError('choose whether this is allowed, and for whom');
  const mode = args.mode;
  const note = text(args.note).slice(0, 500) || null;
  // Absent means "leave the list alone"; an empty list means nobody.
  const sent = Array.isArray(args.userIds);
  const userIds = sent ? (args.userIds as unknown[]).filter((v): v is string => typeof v === 'string' && UUID.test(v)).slice(0, 500) : [];
  if (!db.transaction) throw new Error('MCP policy changes require transactions');
  await db.transaction(async (tx) => {
    await tx.query(
      `insert into mcp_policy (id, mode, note, updated_at, updated_by) values (true, $1, $2, now(), $3)
       on conflict (id) do update set mode = excluded.mode, note = excluded.note, updated_at = now(), updated_by = excluded.updated_by`,
      [mode, note, args.actorUserId]);
    if (mode === 'specific_users' && sent) {
      const valid = userIds.length ? await tx.query<{ id: string }>('select id from users where id = any($1::uuid[])', [userIds]) : [];
      await tx.query('delete from mcp_allowed_users');
      for (const row of valid) await tx.query('insert into mcp_allowed_users (user_id) values ($1) on conflict do nothing', [row.id]);
    }
    await appendEvent(tx, {
      actorUserId: args.actorUserId, actor: 'super_admin', kind: 'mcp.policy_set',
      payload: { mode, namedCount: mode === 'specific_users' ? userIds.length : 0 },
    });
  });
  return mcpPolicy(db);
}

// ------------------------------------------------------------------ storage

const VAULT_SERVICE = 'mcp';
const PKCE_SERVICE = 'mcp.pkce';

async function requireVault(tx: Db, owner: string): Promise<void> {
  await requireConnectorVault(tx);
  const [box] = await tx.query<{ locked: boolean }>('select locked from vault_boxes where owner_user_id=$1', [owner]);
  if (box?.locked) throw new VaultLockedError('Unlock your Vault box to use this connection.');
}

const transaction = <T>(db: Db, work: (tx: Db) => Promise<T>): Promise<T> => {
  if (!db.transaction) throw new VaultError('MCP connections require transactions');
  return db.transaction(work);
};

export async function listMcpConnections(db: Db, ownerUserId: string): Promise<McpConnectionRow[]> {
  return db.query<McpConnectionRow>(
    'select * from mcp_connections where owner_user_id = $1 order by created_at, id', [ownerUserId]);
}

/** One connection, by id AND owner. Somebody else's id is "not found", the
 * same answer as one that never existed. */
export async function mcpConnectionById(db: Db, ownerUserId: string, id: string): Promise<McpConnectionRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db.query<McpConnectionRow>(
    'select * from mcp_connections where id = $1 and owner_user_id = $2', [id, ownerUserId]);
  return row ?? null;
}

async function freeSlug(tx: Db, ownerUserId: string, wanted: string, explicit: boolean): Promise<string> {
  const taken = new Set((await tx.query<{ slug: string }>('select slug from mcp_connections where owner_user_id = $1', [ownerUserId])).map((r) => r.slug));
  if (!taken.has(wanted)) return wanted;
  if (explicit) throw new McpAccessError(409, 'you already have a server with that short name; choose another');
  for (let n = 2; n < 200; n += 1) {
    const candidate = `${wanted.slice(0, 32 - String(n).length - 1)}_${n}`;
    if (!taken.has(candidate) && SLUG.test(candidate)) return candidate;
  }
  throw new McpAccessError(409, 'choose a short name for this server');
}

export interface NewMcpConnection {
  ownerUserId: string;
  name: string;
  slug: string;
  /** True when the person typed the short name, false when it was derived. */
  slugExplicit: boolean;
  url: string;
  host: string;
  authKind: McpAuthKind;
  authHeader: string | null;
  /** The token or header value, or for OAuth the client secret if there is one. */
  secret: McpSecret | null;
  oauth?: McpOAuthInfo | null;
  /** What connecting found. Absent for OAuth, which has not signed in yet. */
  probe?: McpProbe | null;
}

function secretOf(authKind: McpAuthKind, secret: McpSecret | null): McpSecret | null {
  if (authKind === 'bearer') {
    if (!secret || !('token' in secret)) throw new McpInputError('a token is required');
    return { token: validateMcpToken(secret.token) };
  }
  if (authKind === 'header') {
    if (!secret || !('value' in secret)) throw new McpInputError('a header value is required');
    return { value: validateMcpHeaderValue(secret.value) };
  }
  if (authKind === 'oauth') {
    const s = (secret ?? {}) as { clientSecret?: string | null; accessToken?: string | null; refreshToken?: string | null };
    const kept = { clientSecret: s.clientSecret ?? null, accessToken: s.accessToken ?? null, refreshToken: s.refreshToken ?? null };
    return kept.clientSecret || kept.accessToken || kept.refreshToken ? kept : null;
  }
  return null;
}

const vaultLabel = (name: string) => `MCP server sign-in (${name.slice(0, 60)})`;

/** Saves a connection. For every method but OAuth the server has ALREADY
 * answered and listed its tools: an address that does not work is never
 * stored as though it did. */
export async function createMcpConnection(db: Db, key: MasterKey, args: NewMcpConnection): Promise<McpConnectionRow> {
  const secret = secretOf(args.authKind, args.secret);
  return transaction(db, async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtext('josi_mcp_owner'), hashtext($1))", [args.ownerUserId]);
    await requirePermission(tx, args.ownerUserId);
    const [{ n }] = await tx.query<{ n: number }>('select count(*)::int as n from mcp_connections where owner_user_id = $1', [args.ownerUserId]);
    if (n >= MAX_MCP_CONNECTIONS_PER_PERSON) {
      throw new McpAccessError(409, `At most ${MAX_MCP_CONNECTIONS_PER_PERSON} MCP servers can be connected. Remove one first.`);
    }
    const slug = await freeSlug(tx, args.ownerUserId, args.slug, args.slugExplicit);
    const id = randomUUID();
    let reference: string | null = null;
    if (secret) {
      await requireVault(tx, args.ownerUserId);
      reference = await storeVaultCredentialPayload(tx, key, {
        ownerUserId: args.ownerUserId, kind: args.authKind === 'oauth' ? 'oauth_token' : 'api_key',
        service: VAULT_SERVICE, slot: id, label: vaultLabel(args.name), payload: { ...secret }, actorUserId: args.ownerUserId,
      });
    }
    const merged = args.probe ? mergeMcpTools([], args.probe.tools, true) : { tools: [], askFirst: [] };
    const [row] = await tx.query<McpConnectionRow>(
      `insert into mcp_connections
         (id, owner_user_id, name, slug, url, host, auth_kind, auth_header, credentials_enc, oauth, status,
          last_check_at, last_check_ok, server_name, protocol_version, tools, tools_fetched_at, tools_dropped, ask_first_names)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
       returning *`,
      [
        id, args.ownerUserId, args.name, slug, args.url, args.host, args.authKind,
        args.authKind === 'header' ? args.authHeader : null, reference, json(args.oauth ?? {}),
        args.probe ? 'active' : 'needs_sign_in',
        args.probe ? new Date().toISOString() : null, args.probe ? true : null,
        args.probe?.serverName ?? null, args.probe?.protocolVersion ?? null,
        json(merged.tools), args.probe ? new Date().toISOString() : null, args.probe?.dropped ?? 0, merged.askFirst,
      ]);
    await appendEvent(tx, {
      actorUserId: args.ownerUserId, actor: 'member', kind: 'mcp.connection_added',
      subjectType: 'mcp_connection', subjectId: id,
      // Where, and which KIND of sign-in. Never the sign-in itself.
      payload: { slug, host: args.host, authKind: args.authKind },
    });
    return row;
  });
}

/** Rename, switch on or off, or switch single tools off. Nothing here changes
 * where the connection goes or how it signs in: for that, remove it and add
 * it again, so the server is asked afresh. */
export async function updateMcpConnection(db: Db, args: {
  ownerUserId: string; id: string; name?: string; enabled?: boolean; disabledTools?: string[];
}): Promise<McpConnectionRow> {
  const current = await mcpConnectionById(db, args.ownerUserId, args.id);
  if (!current) throw new McpAccessError(404, 'there is no such server');
  // Switching something OFF is always allowed. Everything else needs the
  // permission the person had when they added it.
  const onlyOff = args.name === undefined && args.disabledTools === undefined && args.enabled === false;
  if (!onlyOff) await requirePermission(db, args.ownerUserId);
  const known = new Set(current.tools.map((t) => t.name));
  const disabled = args.disabledTools === undefined ? current.disabled_tools
    : [...new Set(args.disabledTools.filter((n) => typeof n === 'string' && known.has(n)))].slice(0, 200);
  const [row] = await db.query<McpConnectionRow>(
    `update mcp_connections set name = $3, enabled = $4, disabled_tools = $5
      where id = $1 and owner_user_id = $2 returning *`,
    [args.id, args.ownerUserId, args.name ?? current.name, args.enabled ?? current.enabled, disabled]);
  await appendEvent(db, {
    actorUserId: args.ownerUserId, actor: 'member', kind: 'mcp.connection_updated',
    subjectType: 'mcp_connection', subjectId: args.id,
    payload: { slug: current.slug, enabled: row.enabled, toolsOff: disabled.length },
  });
  return row;
}

/** Removes a connection and its sealed sign-in. Always allowed: it is the
 * person's own, whatever the policy now says. */
export async function deleteMcpConnection(db: Db, ownerUserId: string, id: string): Promise<boolean> {
  if (!UUID.test(id)) return false;
  return transaction(db, async (tx) => {
    await tx.query('select id from vault_state where id=true for share');
    const states = await tx.query<{ state_hash: string }>(
      'select state_hash from mcp_oauth_states where connection_id = $1 and user_id = $2', [id, ownerUserId]);
    const rows = await tx.query<{ slug: string }>(
      'delete from mcp_connections where id = $1 and owner_user_id = $2 returning slug', [id, ownerUserId]);
    if (!rows.length) return false;
    // Pending calls and sign-ins in progress go with the row, by cascade. The
    // sealed values do not live in the row, so they are removed here.
    await deleteVaultSlot(tx, { ownerUserId, service: VAULT_SERVICE, slot: id, actorUserId: ownerUserId });
    for (const state of states) await deleteVaultSlot(tx, { ownerUserId, service: PKCE_SERVICE, slot: state.state_hash, actorUserId: ownerUserId });
    await appendEvent(tx, {
      actorUserId: ownerUserId, actor: 'member', kind: 'mcp.connection_removed',
      subjectType: 'mcp_connection', subjectId: id, payload: { slug: rows[0].slug },
    });
    return true;
  });
}

// ---------------------------------------------------------- the tool list

/**
 * Decides, for a freshly fetched tool list, which tools ask first.
 *
 * `trusted` is true only when the PERSON asked for the list themselves on the
 * settings page (adding, signing in, pressing Check). Then what the server
 * declares is accepted: read-only tools run freely, everything else asks.
 *
 * Otherwise — a refresh Josi did on its own — a tool that has been seen NOT
 * read-only keeps asking, whatever the server says now. Without that, a server
 * could offer "delete everything" honestly on Monday and relabel it read-only
 * on Tuesday, and it would run unasked.
 */
export function mergeMcpTools(
  askFirstBefore: string[], fresh: McpToolRecord[], trusted: boolean,
): { tools: McpToolRecord[]; askFirst: string[] } {
  const remembered = new Set(trusted ? [] : askFirstBefore);
  const tools = fresh.map((tool) => ({ ...tool, asks: !tool.readOnly || remembered.has(tool.name) }));
  for (const tool of tools) if (!tool.readOnly) remembered.add(tool.name);
  return { tools, askFirst: [...remembered].slice(0, 2000) };
}

// ---------------------------------------------------------------- sign-in

async function openSecret(db: Db, key: MasterKey, row: McpConnectionRow): Promise<{ secret: McpSecret | null; reference: string | null }> {
  return transaction(db, async (tx) => {
    await requireVault(tx, row.owner_user_id);
    const [current] = await tx.query<{ credentials_enc: string | null }>(
      'select credentials_enc from mcp_connections where id = $1 and owner_user_id = $2', [row.id, row.owner_user_id]);
    if (!current) throw new McpAccessError(404, 'there is no such server');
    if (!current.credentials_enc) return { secret: null, reference: null };
    const secret = await openCredentialPayload<McpSecret>(tx, key, {
      ownerUserId: row.owner_user_id, service: VAULT_SERVICE, slot: row.id, stored: current.credentials_enc,
    });
    return { secret, reference: current.credentials_enc };
  });
}

const needsSignIn = (host: string) => new McpError(`Sign in to ${host} again on the Connections page.`, { category: 'revoked', unauthorized: true });

function oauthParts(row: McpConnectionRow): { metadata: McpOAuthMetadata; info: McpOAuthInfo } {
  const info = row.oauth as McpOAuthInfo;
  if (!info?.clientId || !info.tokenEndpoint || !info.authorizationEndpoint || !info.resource || !info.redirectUri) {
    throw new McpError('this connection has no sign-in details; remove it and add it again', { category: 'provider_error' });
  }
  return { info, metadata: { resource: info.resource, issuer: info.issuer, authorizationEndpoint: info.authorizationEndpoint,
    tokenEndpoint: info.tokenEndpoint, registrationEndpoint: info.registrationEndpoint ?? null, scopes: info.scopes ?? [] } };
}

/** Stores new OAuth tokens, unless somebody else got there first. Returns
 * whether THESE tokens were the ones kept. */
async function saveOAuthTokens(
  db: Db, key: MasterKey, row: McpConnectionRow, tokens: McpOAuthTokens, clientSecret: string | null, expectReference: string | null | undefined,
): Promise<boolean> {
  return transaction(db, async (tx) => {
    await requireVault(tx, row.owner_user_id);
    const [current] = await tx.query<{ credentials_enc: string | null; name: string }>(
      'select credentials_enc, name from mcp_connections where id = $1 and owner_user_id = $2 for update', [row.id, row.owner_user_id]);
    if (!current) throw new McpAccessError(404, 'there is no such server');
    if (expectReference !== undefined && current.credentials_enc !== expectReference) return false;
    const reference = await storeVaultCredentialPayload(tx, key, {
      ownerUserId: row.owner_user_id, kind: 'oauth_token', service: VAULT_SERVICE, slot: row.id, label: vaultLabel(current.name),
      payload: { clientSecret, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken }, actorUserId: row.owner_user_id,
    });
    await tx.query(
      `update mcp_connections set credentials_enc = $2,
         oauth = oauth || jsonb_build_object('expiresAt', $3::bigint, 'signedIn', true)
       where id = $1`, [row.id, reference, tokens.expiresAt]);
    return true;
  });
}

/** The sign-in, as request headers, for one use. Refreshes an OAuth token
 * that has run out (or, with `force`, one the server just refused). */
async function authHeaders(db: Db, key: MasterKey, row: McpConnectionRow, net: McpNetOptions, force: boolean): Promise<Record<string, string>> {
  if (row.auth_kind === 'none') return {};
  const { secret, reference } = await openSecret(db, key, row);
  if (row.auth_kind === 'bearer') {
    if (!secret || !('token' in secret)) throw needsSignIn(row.host);
    return { authorization: `Bearer ${secret.token}` };
  }
  if (row.auth_kind === 'header') {
    if (!secret || !('value' in secret) || !row.auth_header) throw needsSignIn(row.host);
    return { [row.auth_header.toLowerCase()]: secret.value };
  }
  const held = (secret ?? {}) as { clientSecret?: string | null; accessToken?: string | null; refreshToken?: string | null };
  if (!held.accessToken) throw needsSignIn(row.host);
  const { metadata, info } = oauthParts(row);
  const [latest] = await db.query<{ oauth: Partial<McpOAuthInfo> }>('select oauth from mcp_connections where id = $1', [row.id]);
  const expiresAt = typeof latest?.oauth?.expiresAt === 'number' ? latest.oauth.expiresAt : null;
  const expiring = expiresAt !== null && expiresAt - Date.now() < 60_000;
  if (!force && !expiring) return { authorization: `Bearer ${held.accessToken}` };
  if (!held.refreshToken) {
    if (force) throw needsSignIn(row.host);
    // Nothing to refresh with: try the token as it is and let the server say.
    return { authorization: `Bearer ${held.accessToken}` };
  }
  const client: McpOAuthClient = { clientId: info.clientId, clientSecret: held.clientSecret ?? null, tokenAuth: info.tokenAuth ?? 'none' };
  const tokens = await refreshMcpOAuthTokens(metadata, client, held.refreshToken, net);
  if (await saveOAuthTokens(db, key, row, tokens, held.clientSecret ?? null, reference)) {
    return { authorization: `Bearer ${tokens.accessToken}` };
  }
  // Another request refreshed at the same moment. Use what it stored.
  const again = await openSecret(db, key, row);
  const current = (again.secret ?? {}) as { accessToken?: string | null };
  if (!current.accessToken) throw needsSignIn(row.host);
  return { authorization: `Bearer ${current.accessToken}` };
}

/**
 * Opens a session with the server, does one piece of work, and closes it.
 *
 * A 401 on an OAuth connection is answered once by refreshing the token and
 * trying again. A 401 means the request was refused before anything ran, so
 * the second attempt cannot be a repeat of something that happened.
 */
export async function withMcpSession<T>(
  db: Db, key: MasterKey, row: McpConnectionRow, net: McpNetOptions,
  work: (target: McpTarget, session: McpSession) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let target: McpTarget | null = null;
    let session: McpSession | null = null;
    try {
      target = { url: row.url, authHeaders: await authHeaders(db, key, row, net, attempt === 1) };
      session = await mcpInitialize(target, net);
      const out = await work(target, session);
      await mcpClose(target, session, net);
      return out;
    } catch (err) {
      if (target && session) await mcpClose(target, session, net);
      if (err instanceof McpError && err.unauthorized && row.auth_kind === 'oauth' && attempt === 0) continue;
      throw err;
    }
  }
}

/** Writes down how the last contact went. A sentence Josi wrote; never the
 * server's words. A tool's own error is not a connection problem and changes
 * nothing here. */
export async function recordMcpOutcome(db: Db, row: McpConnectionRow, err: unknown): Promise<void> {
  if (err instanceof McpError && err.rpcCode !== null) return;
  if (err instanceof VaultError) return;
  if (!err) {
    await db.query(
      `update mcp_connections set status = 'active', last_check_at = now(), last_check_ok = true, last_error = null where id = $1`, [row.id]);
    return;
  }
  const unauthorized = err instanceof McpError && err.unauthorized;
  const sentence = err instanceof McpError ? err.message : 'Josi could not complete the check.';
  await db.query(
    `update mcp_connections set
       status = case when $2 then $3 else status end,
       oauth = case when $2 and auth_kind = 'oauth' then oauth || '{"signedIn": false}'::jsonb else oauth end,
       last_check_at = now(), last_check_ok = false, last_error = $4
     where id = $1`,
    [row.id, unauthorized, row.auth_kind === 'oauth' ? 'needs_sign_in' : 'needs_attention', cleanMcpLine(sentence, 300)]);
}

export interface McpProbe {
  serverName: string | null;
  protocolVersion: string;
  tools: McpToolRecord[];
  dropped: number;
}

/** Connects and lists tools with headers supplied by the caller. Used before
 * anything is saved, so it touches no database. */
export async function probeMcpServer(target: McpTarget, net: McpNetOptions = {}): Promise<McpProbe> {
  const session = await mcpInitialize(target, net);
  try {
    const list = await mcpListTools(target, session, net);
    return { serverName: session.serverName, protocolVersion: session.protocolVersion, tools: list.tools, dropped: list.dropped };
  } finally {
    await mcpClose(target, session, net);
  }
}

/** The headers a not-yet-saved connection would send. */
export function mcpHeadersFor(authKind: McpAuthKind, authHeader: string | null, secret: { token?: string; value?: string }): Record<string, string> {
  if (authKind === 'bearer' && secret.token) return { authorization: `Bearer ${secret.token}` };
  if (authKind === 'header' && authHeader && secret.value) return { [authHeader.toLowerCase()]: secret.value };
  return {};
}

/**
 * Asks the server again: is it there, does the sign-in still work, and what
 * tools does it offer now.
 *
 * `trusted` says who asked. True from the settings page (the person pressed
 * Check, or has just signed in); false when Josi refreshes on its own, in
 * which case a tool cannot quietly stop asking (see `mergeMcpTools`).
 */
export async function checkMcpConnection(
  db: Db, key: MasterKey, row: McpConnectionRow, net: McpNetOptions, opts: { trusted: boolean },
): Promise<McpConnectionRow> {
  await requirePermission(db, row.owner_user_id);
  let probe: McpProbe;
  try {
    probe = await withMcpSession(db, key, row, net, async (target, session) => {
      const list = await mcpListTools(target, session, net);
      return { serverName: session.serverName, protocolVersion: session.protocolVersion, tools: list.tools, dropped: list.dropped };
    });
  } catch (err) {
    await recordMcpOutcome(db, row, err);
    throw err;
  }
  const [before] = await db.query<{ ask_first_names: string[] }>('select ask_first_names from mcp_connections where id = $1', [row.id]);
  const merged = mergeMcpTools(before?.ask_first_names ?? [], probe.tools, opts.trusted);
  const names = new Set(merged.tools.map((t) => t.name));
  const [saved] = await db.query<McpConnectionRow>(
    `update mcp_connections set
       status = 'active', last_check_at = now(), last_check_ok = true, last_error = null,
       server_name = $2, protocol_version = $3, tools = $4, tools_fetched_at = now(), tools_dropped = $5,
       ask_first_names = $6, disabled_tools = $7
     where id = $1 and owner_user_id = $8 returning *`,
    [row.id, probe.serverName, probe.protocolVersion, json(merged.tools), probe.dropped, merged.askFirst,
      row.disabled_tools.filter((n) => names.has(n)), row.owner_user_id]);
  if (!saved) throw new McpAccessError(404, 'there is no such server');
  return saved;
}

/** Runs one tool now, with exactly these arguments. The caller has already
 * decided this may run (a read-only tool, or an approved call). */
export async function runMcpTool(
  db: Db, key: MasterKey, row: McpConnectionRow, toolName: string, args: Record<string, unknown>, net: McpNetOptions,
): Promise<McpToolResult> {
  await requirePermission(db, row.owner_user_id);
  try {
    const result = await withMcpSession(db, key, row, net, (target, session) => mcpCallTool(target, session, toolName, args, net));
    await recordMcpOutcome(db, row, null);
    return result;
  } catch (err) {
    await recordMcpOutcome(db, row, err);
    throw err;
  }
}

// ------------------------------------------------------------------ OAuth

/**
 * Everything browser sign-in needs, found before anything is saved.
 *
 * The server is asked once WITHOUT a sign-in. It must answer 401: a server
 * that answers anyway needs no sign-in at all, and saying so beats sending
 * somebody to a sign-in page that does not exist.
 */
export async function prepareMcpOAuth(
  url: string,
  args: { redirectUri: string; clientId?: string | null; clientSecret?: string | null },
  net: McpNetOptions = {},
): Promise<{ info: McpOAuthInfo; clientSecret: string | null }> {
  let challenge: string | null = null;
  try {
    const session = await mcpInitialize({ url, authHeaders: {} }, net);
    await mcpClose({ url, authHeaders: {} }, session, net);
    throw new McpInputError('This server answered without asking for a sign-in. Choose "No sign-in" instead.');
  } catch (err) {
    if (!(err instanceof McpError) || !err.unauthorized) throw err;
    challenge = err.wwwAuthenticate;
  }
  const metadata = await discoverMcpOAuth(url, challenge, net);
  let client: McpOAuthClient;
  if (args.clientId) {
    client = { clientId: validateMcpClientId(args.clientId), clientSecret: args.clientSecret ? secretValue(args.clientSecret, 'client secret') : null,
      tokenAuth: args.clientSecret ? 'client_secret_post' : 'none' };
  } else if (metadata.registrationEndpoint) {
    client = await registerMcpOAuthClient(metadata, { redirectUri: args.redirectUri }, net);
  } else {
    throw new McpInputError(
      'This server does not let Josi register itself. Register an app with it yourself, using the return address shown here, '
      + 'then paste the client id it gives you.',
      'client_id_required',
    );
  }
  return {
    info: { ...metadata, clientId: client.clientId, tokenAuth: client.tokenAuth, redirectUri: args.redirectUri, expiresAt: null, signedIn: false },
    clientSecret: client.clientSecret,
  };
}

const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
const STATE_TTL_SECONDS = 600;

/** Starts a browser sign-in: a single-use state bound to this person and this
 * connection, a PKCE pair, and the address to open. */
export async function startMcpOAuth(db: Db, key: MasterKey, args: {
  userId: string; connectionId: string; native?: boolean;
}): Promise<{ authorizationUrl: string; state: string }> {
  await requirePermission(db, args.userId);
  const row = await mcpConnectionById(db, args.userId, args.connectionId);
  if (!row) throw new McpAccessError(404, 'there is no such server');
  if (row.auth_kind !== 'oauth') throw new McpInputError('this server does not use browser sign-in');
  const { metadata, info } = oauthParts(row);
  const { verifier, challenge } = createMcpPkce();
  const state = randomBytes(32).toString('base64url');
  const hash = stateHash(state);
  await transaction(db, async (tx) => {
    await requireVault(tx, args.userId);
    const reference = await storeVaultCredentialPayload(tx, key, {
      ownerUserId: args.userId, kind: 'oauth_token', service: PKCE_SERVICE, slot: hash,
      label: 'Temporary MCP sign-in verifier', payload: { verifier }, actorUserId: args.userId,
    });
    await tx.query(
      `insert into mcp_oauth_states (state_hash, user_id, connection_id, verifier_enc, redirect_uri, native, expires_at)
       values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))`,
      [hash, args.userId, row.id, reference, info.redirectUri, args.native === true, STATE_TTL_SECONDS]);
  });
  return {
    state,
    authorizationUrl: buildMcpAuthorizationUrl(metadata, { clientId: info.clientId, redirectUri: info.redirectUri, state, challenge }),
  };
}

/** What a callback may know about a state before using it: whose it is and
 * whether a phone app started it. Uses nothing up. */
export async function peekMcpOAuthState(db: Db, state: unknown): Promise<{ userId: string; native: boolean } | null> {
  if (typeof state !== 'string' || !state || state.length > 512) return null;
  const [row] = await db.query<{ user_id: string; native: boolean }>(
    'select user_id, native from mcp_oauth_states where state_hash = $1 and consumed_at is null and expires_at > now()', [stateHash(state)]);
  return row ? { userId: row.user_id, native: row.native } : null;
}

export type McpOAuthFailure = 'unknown' | 'consumed' | 'expired' | 'wrong_person' | 'declined' | 'failed';

/**
 * Finishes a browser sign-in.
 *
 * Who is signing in and to which connection come from the STORED state, never
 * from the address the browser came back on — and `userId` must be the person
 * that state was made for. The state is used up before the code is spent, so
 * a replayed callback is a refusal.
 */
export async function finishMcpOAuth(db: Db, key: MasterKey, args: {
  state: unknown; code: unknown; userId: string; declined?: boolean;
}, net: McpNetOptions = {}): Promise<{ ok: true; connection: McpConnectionRow } | { ok: false; reason: McpOAuthFailure }> {
  if (typeof args.state !== 'string' || !args.state || args.state.length > 512) return { ok: false, reason: 'unknown' };
  const hash = stateHash(args.state);
  const claimed = await transaction(db, async (tx) => {
    await tx.query('select id from vault_state where id=true for share');
    const [row] = await tx.query<{
      user_id: string; connection_id: string; verifier_enc: string | null; redirect_uri: string; expires_at: string; consumed_at: string | null;
    }>('select * from mcp_oauth_states where state_hash = $1 for update', [hash]);
    if (!row) return { ok: false as const, reason: 'unknown' as const };
    if (row.consumed_at) return { ok: false as const, reason: 'consumed' as const };
    // Somebody else's state is refused WITHOUT being used up, so a stolen
    // link cannot be burned to stop its owner finishing.
    if (row.user_id !== args.userId) return { ok: false as const, reason: 'wrong_person' as const };
    const expired = new Date(row.expires_at).getTime() <= Date.now();
    let verifier: string | null = null;
    if (!expired && !args.declined && row.verifier_enc) {
      await requireVault(tx, row.user_id);
      const payload = await openCredentialPayload<{ verifier: string }>(tx, key, {
        ownerUserId: row.user_id, service: PKCE_SERVICE, slot: hash, stored: row.verifier_enc });
      verifier = typeof payload.verifier === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(payload.verifier) ? payload.verifier : null;
    }
    await tx.query('update mcp_oauth_states set consumed_at = now(), verifier_enc = null where state_hash = $1', [hash]);
    await deleteVaultSlot(tx, { ownerUserId: row.user_id, service: PKCE_SERVICE, slot: hash, actorUserId: row.user_id });
    if (expired) return { ok: false as const, reason: 'expired' as const };
    if (args.declined) return { ok: false as const, reason: 'declined' as const };
    if (!verifier) return { ok: false as const, reason: 'failed' as const };
    return { ok: true as const, verifier, connectionId: row.connection_id, redirectUri: row.redirect_uri };
  });
  if (!claimed.ok) return claimed;
  if (typeof args.code !== 'string' || !args.code || args.code.length > 4096) return { ok: false, reason: 'failed' };

  const row = await mcpConnectionById(db, args.userId, claimed.connectionId);
  if (!row || row.auth_kind !== 'oauth' || !(await mcpPermitted(db, args.userId))) return { ok: false, reason: 'failed' };
  const { metadata, info } = oauthParts(row);
  try {
    const { secret } = await openSecret(db, key, row);
    const clientSecret = (secret as { clientSecret?: string | null } | null)?.clientSecret ?? null;
    const client: McpOAuthClient = { clientId: info.clientId, clientSecret, tokenAuth: info.tokenAuth ?? 'none' };
    const tokens = await exchangeMcpOAuthCode(metadata, client, { code: args.code, verifier: claimed.verifier, redirectUri: claimed.redirectUri }, net);
    await saveOAuthTokens(db, key, row, tokens, clientSecret, undefined);
    await appendEvent(db, {
      actorUserId: args.userId, actor: 'member', kind: 'mcp.signed_in',
      subjectType: 'mcp_connection', subjectId: row.id, payload: { slug: row.slug, host: row.host },
    });
  } catch (err) {
    if (err instanceof VaultError) throw err;
    await recordMcpOutcome(db, row, err);
    return { ok: false, reason: 'failed' };
  }
  // Signed in. Now ask the server what it offers; the person is on the
  // settings page doing this themselves, so the list is taken as declared.
  const fresh = (await mcpConnectionById(db, args.userId, row.id))!;
  try {
    return { ok: true, connection: await checkMcpConnection(db, key, fresh, net, { trusted: true }) };
  } catch (err) {
    if (err instanceof VaultError) throw err;
    return { ok: true, connection: (await mcpConnectionById(db, args.userId, row.id))! };
  }
}

/** Removes sign-ins nobody finished, and their sealed verifiers. */
export async function purgeMcpOAuthStates(db: Db): Promise<number> {
  return transaction(db, async (tx) => {
    await tx.query('select id from vault_state where id=true for share');
    const rows = await tx.query<{ state_hash: string; user_id: string }>(
      `delete from mcp_oauth_states where expires_at < now() - interval '1 hour' or consumed_at < now() - interval '1 hour'
       returning state_hash, user_id`);
    const spent = await tx.query<{ state_hash: string; user_id: string }>(
      `update mcp_oauth_states set verifier_enc = null where verifier_enc is not null and expires_at <= now() returning state_hash, user_id`);
    for (const row of [...rows, ...spent]) {
      await deleteVaultSlot(tx, { ownerUserId: row.user_id, service: PKCE_SERVICE, slot: row.state_hash, actorUserId: row.user_id });
    }
    return rows.length;
  });
}
