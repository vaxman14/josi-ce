// External MCP server connections: the rows, the rules and the allowlist.
//
// `mcpClient.ts` is how Josi talks to a stranger. This file is what Josi
// remembers about one, and it exists to keep two things true that a transport
// cannot keep on its own:
//
//   1. A DISCOVERED TOOL IS NOT AN ALLOWED TOOL. `reconcileMcpTools` writes
//      rows; it grants nothing. Everything arrives at `state = 'new'` and the
//      owner moves it, one tool at a time, having read what it says it does.
//   2. WHAT WAS APPROVED IS PINNED. `toolDigest` hashes the exact words the
//      owner read — name, title, description, input schema. A server that
//      changes any of them afterwards finds its tool moved to `changed` and off
//      the allowlist. That is the difference between this and every other
//      connection in CE: elsewhere the description of what may happen was
//      written by somebody here, and here it was written by the far end.
//
// NOTHING IN THIS FILE RETURNS A CREDENTIAL. `openMcpCredentials` is the single
// exception and it hands the value to one caller at the moment of a request.
import { createHash } from 'node:crypto';
import { appendEvent, json, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import type { ErrorCategory } from './providers.js';
import type { DiscoveredMcpTool, McpSecret } from './mcpClient.js';

// ------------------------------------------------------------------- shapes

export type McpAuthKind = 'none' | 'bearer' | 'api_key';

/** Where one tool stands with its owner. See migration 0036 for what each one
 * means and why `changed` is separate from `new`. */
export type McpToolState = 'new' | 'approved' | 'revoked' | 'changed';

/** What happens when the assistant calls an approved tool. The OWNER's answer,
 * never the server's. */
export type McpApprovalMode = 'ask' | 'auto';

export interface McpServerRow {
  id: string;
  owner_user_id: string;
  name: string;
  slug: string;
  endpoint_url: string;
  host: string;
  auth_kind: McpAuthKind;
  auth_header: string | null;
  credentials_enc: string | null;
  enabled: boolean;
  status: 'unverified' | 'active' | 'needs_attention';
  last_check_at: string | null;
  last_check_ok: boolean | null;
  last_error_category: ErrorCategory | null;
  protocol_version: string | null;
  server_label: string | null;
  last_discovery_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpToolRow {
  id: string;
  server_id: string;
  tool_name: string;
  title: string | null;
  description: string;
  input_schema: Record<string, unknown>;
  server_read_only_hint: boolean | null;
  definition_digest: string;
  state: McpToolState;
  approval_mode: McpApprovalMode;
  available: boolean;
  first_seen_at: string;
  last_seen_at: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface McpPendingCallRow {
  id: string;
  owner_user_id: string;
  tool_id: string;
  thread_id: string | null;
  summary: string;
  request_enc: string;
  payload_hash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  decided_at: string | null;
  decided_by: string | null;
  executed_at: string | null;
  result_ok: boolean | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** How many servers one person may connect.
 *
 * A ceiling rather than a policy setting, because the number that matters is
 * "more than anybody has a reason for" and an operator asked to choose it has
 * been handed a question they cannot answer. Every one of these is contacted on
 * the turn it is offered, so an unbounded list is an unbounded per-turn cost
 * for the person who made it. */
export const MAX_MCP_SERVERS_PER_USER = 10;

// --------------------------------------------------------------- validation

export class McpInputError extends Error {}

const MAX_NAME_CHARS = 80;
const MAX_SECRET_CHARS = 4096;

/** Whitespace and control characters, written as escapes so this file contains
 * none of them. Either one inside a pasted credential means the paste took
 * something it should not have — and a newline in a header value is request
 * splitting. */
const NOT_IN_A_SECRET = /[\s\u0000-\u001f\u007f]/;

const text = (raw: unknown): string => (typeof raw === 'string' ? raw.trim() : '');

export function validateMcpName(raw: unknown): string {
  const name = text(raw);
  if (!name) throw new McpInputError('give this server a name you will recognise later');
  if (name.length > MAX_NAME_CHARS) {
    throw new McpInputError(`a name can be at most ${MAX_NAME_CHARS} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new McpInputError('a name cannot contain control characters or line breaks');
  }
  return name;
}

/**
 * The identifier the MODEL sees, and the first half of every tool call it can
 * form.
 *
 * Constrained to an identifier so a name can never carry a path, a host, a
 * quote or a newline into a prompt. Derived from the display name when nobody
 * supplies one, because asking for two names to describe one thing is how the
 * second one ends up being `asdf`.
 */
export function validateMcpSlug(raw: unknown, fallbackName?: string): string {
  let slug = text(raw).toLowerCase();
  if (!slug && fallbackName) {
    slug = fallbackName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    if (/^[0-9_]/.test(slug)) slug = `mcp_${slug}`.slice(0, 40);
    slug = slug.replace(/_+$/, '');
  }
  if (!/^[a-z][a-z0-9_]{0,38}[a-z0-9]$/.test(slug)) {
    throw new McpInputError(
      'a short name for the assistant must be 2 to 40 characters of lowercase letters, digits and '
      + 'underscores, starting with a letter — for example "my_notes"',
    );
  }
  return slug;
}

export interface ValidatedMcpEndpoint {
  endpointUrl: string;
  host: string;
}

/**
 * The server's MCP endpoint, and the host allowlist derived from it.
 *
 * HTTPS ONLY, and not negotiable through the form: an MCP session carries this
 * person's token in a header on every request, and "they typed it, so they
 * meant it" is not a defence for putting a credential on the wire in clear
 * text.
 *
 * A credential in the URL is refused for the reason it always is — a URL
 * reaches logs, proxies and error messages, and this one is about to be stored.
 *
 * A query string IS allowed, unlike the custom API base URL, and the difference
 * is real rather than an oversight: there, every request appends its own path
 * and query to the base, so a base carrying one would either lose it or produce
 * a URL nobody reviewed. Here there is exactly one URL and every request is a
 * POST to it unchanged, so a server that identifies its endpoint with `?key=`
 * works and nothing is silently dropped. A fragment is still refused: it never
 * travels, so accepting one would mean storing an address that is not the one
 * used.
 */
export function validateMcpEndpointUrl(raw: unknown): ValidatedMcpEndpoint {
  const value = text(raw);
  if (!value) throw new McpInputError('give the server\'s address, starting with https://');
  if (value.length > 500) throw new McpInputError('that address is too long');

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpInputError('that is not a valid web address');
  }
  if (url.protocol !== 'https:') {
    throw new McpInputError(
      'the address must start with https://. Josi will not send a credential over an unencrypted '
      + 'connection, and MCP over plain http would put every tool call in clear text too.',
    );
  }
  if (url.username || url.password) {
    throw new McpInputError('put the credential in the authentication fields, not in the address');
  }
  if (url.hash) {
    throw new McpInputError('the address cannot carry a #fragment — a fragment is never sent');
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host.includes('/')) throw new McpInputError('that address has no host in it');
  if (url.pathname.includes('..')) throw new McpInputError('the address cannot contain ".."');
  return { endpointUrl: url.toString(), host };
}

export function validateMcpAuthKind(raw: unknown): McpAuthKind {
  const value = text(raw) || 'none';
  if (value === 'none' || value === 'bearer' || value === 'api_key') return value;
  throw new McpInputError('choose no credential, a bearer token, or an API key in a header');
}

/** `api_key` only: which header carries it.
 *
 * A header NAME, checked against the RFC 7230 token grammar, so nothing here
 * can inject a second header or a request line. There is no query-string
 * variant on purpose: a key in a URL is a key in the access log of every proxy
 * between here and there. */
export function validateMcpAuthHeader(raw: unknown): string {
  const header = text(raw);
  if (!header) throw new McpInputError('say which header carries the API key, for example X-API-Key');
  if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/.test(header)) {
    throw new McpInputError('that is not a valid HTTP header name');
  }
  return header;
}

/** The credential, or nothing. Returns the sealed-payload shape, never the
 * plaintext to anything except `seal`. */
export function validateMcpCredentials(
  authKind: McpAuthKind,
  body: { secret?: unknown },
): McpSecret {
  if (authKind === 'none') return null;
  const value = body.secret;
  const what = authKind === 'bearer' ? 'a token' : 'an API key';
  if (typeof value !== 'string' || !value.trim()) throw new McpInputError(`${what} is required`);
  const secret = value.trim();
  if (secret.length > MAX_SECRET_CHARS) throw new McpInputError(`that ${what} is too long`);
  if (NOT_IN_A_SECRET.test(secret)) {
    throw new McpInputError(
      `that ${what} contains a space, a line break or a character that cannot travel in an HTTP `
      + 'header — paste just the value',
    );
  }
  return { secret };
}

// ---------------------------------------------------------------- the digest

/**
 * What the owner actually read, hashed.
 *
 * The name, the title, the description and the input schema — every word the
 * approval decision was made on. A server that changes any of them is offering
 * a different tool under a name somebody already agreed to, which is the one
 * attack this feature has that no other connection in CE does.
 *
 * The schema is hashed through a key-sorted serialisation, so a server that
 * reorders its own JSON does not spuriously look like it changed its mind.
 */
export function toolDigest(tool: Pick<DiscoveredMcpTool, 'name' | 'title' | 'description' | 'inputSchema'>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
      return entries.map(([k, v]) => [k, canonical(v)]);
    }
    return value;
  };
  return createHash('sha256')
    .update(JSON.stringify([tool.name, tool.title ?? '', tool.description, canonical(tool.inputSchema)]))
    .digest('hex');
}

// ------------------------------------------------------------------ storage

const UUID = /^[0-9a-fA-F-]{36}$/;

/** Somebody's own servers. Owner-scoped by the query, so there is no id for a
 * caller to substitute. */
export async function listMcpServers(db: Db, ownerUserId: string): Promise<McpServerRow[]> {
  return db.query<McpServerRow>(
    `select * from mcp_servers where owner_user_id = $1 order by name`,
    [ownerUserId],
  );
}

/** By id, without an owner check. Every caller that serves a person pairs this
 * with one; the two are separate so the administrator's cut-off route can act
 * on a row it deliberately reads nothing from. */
export async function mcpServerById(db: Db, id: string): Promise<McpServerRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<McpServerRow>(`select * from mcp_servers where id = $1`, [id]);
  return rows[0] ?? null;
}

export interface CreateMcpServerArgs {
  ownerUserId: string;
  name: string;
  slug: string;
  endpointUrl: string;
  host: string;
  authKind: McpAuthKind;
  authHeader: string | null;
  credentials: McpSecret;
}

/** Writes a server. It arrives DISABLED and UNVERIFIED, always.
 *
 * There is no argument that turns it on, and `enableMcpServer` refuses unless
 * the server has actually completed a handshake — so nothing reaches the
 * assistant on the strength of a form somebody filled in. */
export async function createMcpServer(
  db: Db,
  key: MasterKey,
  args: CreateMcpServerArgs,
): Promise<McpServerRow> {
  const rows = await db.query<McpServerRow>(
    `insert into mcp_servers
       (owner_user_id, name, slug, endpoint_url, host, auth_kind, auth_header, credentials_enc)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     returning *`,
    [
      args.ownerUserId, args.name, args.slug, args.endpointUrl, args.host, args.authKind,
      args.authKind === 'api_key' ? args.authHeader : null,
      args.credentials ? seal(key, args.credentials) : null,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: 'mcp.server_added',
    subjectType: 'mcp_server',
    subjectId: rows[0].id,
    // The slug, the host and which KIND of authentication. Never the credential
    // — and `appendEvent` would refuse a `secret` key anyway, which is the
    // backstop working rather than a reason to be careless here.
    payload: { slug: args.slug, host: args.host, authKind: args.authKind },
  });
  return rows[0];
}

export interface UpdateMcpServerArgs {
  actorUserId: string;
  server: McpServerRow;
  name?: string;
  endpointUrl?: string;
  host?: string;
  authKind?: McpAuthKind;
  authHeader?: string | null;
  /** Absent = leave the stored credential alone. Present = replace it (or
   * remove it, when the new auth kind is `none`). */
  credentials?: McpSecret;
}

/**
 * Edits a server.
 *
 * ANY CHANGE TO WHERE OR HOW IT CONNECTS TAKES IT BACK TO UNVERIFIED AND
 * DISABLED. That is the point of this function existing rather than a bare
 * UPDATE: somebody who repoints a working server at a different address would
 * otherwise leave a row that still says "working, checked on Tuesday" while
 * every tool they approved keeps running against a host nobody has checked —
 * and the tools they approved were described by the OLD server.
 *
 * Renaming is not such a change, so it does not cost the verification.
 */
export async function updateMcpServer(
  db: Db,
  key: MasterKey,
  args: UpdateMcpServerArgs,
): Promise<McpServerRow> {
  const before = args.server;
  const endpointUrl = args.endpointUrl ?? before.endpoint_url;
  const host = args.host ?? before.host;
  const authKind = args.authKind ?? before.auth_kind;
  const authHeader = authKind === 'api_key' ? (args.authHeader ?? before.auth_header) : null;

  const reconnects = endpointUrl !== before.endpoint_url
    || host !== before.host
    || authKind !== before.auth_kind
    || authHeader !== before.auth_header
    || args.credentials !== undefined;

  // `none` has no credential to keep. Leaving the old ciphertext behind would
  // fail the CHECK in 0036, and it would also mean a row that says "no
  // credential" while holding one.
  const credentialsEnc = authKind === 'none'
    ? null
    : (args.credentials ? seal(key, args.credentials) : before.credentials_enc);
  if (authKind !== 'none' && !credentialsEnc) {
    throw new McpInputError('that server needs a credential — paste the token or the API key');
  }

  const rows = await db.query<McpServerRow>(
    `update mcp_servers set
       name = $2,
       endpoint_url = $3,
       host = $4,
       auth_kind = $5,
       auth_header = $6,
       credentials_enc = $7,
       enabled = case when $8 then false else enabled end,
       status = case when $8 then 'unverified' else status end,
       last_check_at = case when $8 then null else last_check_at end,
       last_check_ok = case when $8 then null else last_check_ok end,
       last_error_category = case when $8 then null else last_error_category end
     where id = $1
     returning *`,
    [
      before.id, args.name ?? before.name, endpointUrl, host, authKind, authHeader,
      credentialsEnc, reconnects,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: 'mcp.server_updated',
    subjectType: 'mcp_server',
    subjectId: before.id,
    payload: {
      slug: before.slug,
      host,
      authKind,
      credentialReplaced: args.credentials !== undefined,
      requiresRetest: reconnects,
    },
  });
  return rows[0];
}

/**
 * Turns a server on, or refuses.
 *
 * LEAST PRIVILEGE, ENFORCED RATHER THAN ADVISED: the only way past this is a
 * successful handshake. Every tool under it is still separately approved, so
 * this grants the assistant nothing on its own.
 */
export async function enableMcpServer(
  db: Db,
  args: { actorUserId: string; server: McpServerRow },
): Promise<McpServerRow> {
  if (args.server.last_check_ok !== true) {
    throw new McpInputError(
      'connect to the server first. Josi will not offer its tools on the strength of a form '
      + 'somebody filled in — only on the strength of the server having answered.',
    );
  }
  const rows = await db.query<McpServerRow>(
    `update mcp_servers set enabled = true where id = $1 returning *`,
    [args.server.id],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: 'mcp.server_enabled',
    subjectType: 'mcp_server',
    subjectId: args.server.id,
    payload: { slug: args.server.slug },
  });
  return rows[0];
}

export async function disableMcpServer(
  db: Db,
  args: { actorUserId: string; server: McpServerRow; actor?: 'user' | 'super_admin' },
): Promise<McpServerRow> {
  const rows = await db.query<McpServerRow>(
    `update mcp_servers set enabled = false where id = $1 returning *`,
    [args.server.id],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: args.actor ?? 'user',
    kind: 'mcp.server_disabled',
    subjectType: 'mcp_server',
    subjectId: args.server.id,
    payload: { slug: args.server.slug },
  });
  return rows[0];
}

export async function deleteMcpServer(
  db: Db,
  args: { actorUserId: string; server: McpServerRow; actor?: 'user' | 'super_admin' },
): Promise<void> {
  // The tools and any pending calls under it go with it, by cascade. A pending
  // call against a server that no longer exists is a request nobody could
  // honour and nobody should be asked about.
  await db.query(`delete from mcp_servers where id = $1`, [args.server.id]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: args.actor ?? 'user',
    kind: 'mcp.server_removed',
    subjectType: 'mcp_server',
    subjectId: args.server.id,
    payload: { slug: args.server.slug },
  });
}

/** The credential, for use right now. Returned to one caller, never stored
 * anywhere else, never logged, and never put in a response body. */
export function openMcpCredentials(key: MasterKey, row: McpServerRow): McpSecret {
  if (!row.credentials_enc) return null;
  return openSealed<{ secret: string }>(key, row.credentials_enc);
}

/**
 * Records what the last exchange found — whether it was the owner's connect
 * button or a tool call the assistant made.
 *
 * TWO DIFFERENT CONSEQUENCES, drawn on the same line 0035 draws:
 *
 *   * A REFUSED CREDENTIAL (401, or an expiry) switches the whole server OFF.
 *     Otherwise the assistant would go on choosing tools on a server that is
 *     rejecting this person's token, once per conversation, until they noticed.
 *   * A REFUSED REQUEST (403) marks it as needing attention and leaves it on. A
 *     403 is very often about the ONE thing being asked for rather than about
 *     the credential, and switching off nine working tools because the tenth
 *     touched something out of reach would be a worse failure than the one
 *     being prevented.
 *
 * A rate limit or a transient outage changes neither.
 */
export async function recordMcpCheck(
  db: Db,
  args: {
    serverId: string;
    ok: boolean;
    category?: ErrorCategory | null;
    protocolVersion?: string | null;
    serverLabel?: string | null;
  },
): Promise<void> {
  const credentialRefused = args.category === 'revoked' || args.category === 'expired';
  const needsAttention = credentialRefused || args.category === 'insufficient_scope';
  await db.query(
    `update mcp_servers set
       status = case when $2 then 'active' when $3 then 'needs_attention' else status end,
       enabled = case when $4 then false else enabled end,
       last_check_at = now(), last_check_ok = $2, last_error_category = $5,
       protocol_version = coalesce($6, protocol_version),
       server_label = coalesce($7, server_label)
     where id = $1`,
    [
      args.serverId, args.ok, needsAttention, credentialRefused,
      args.ok ? null : (args.category ?? 'provider_error'),
      args.protocolVersion ?? null, args.serverLabel ?? null,
    ],
  );
}

// ---------------------------------------------------------------- the tools

export async function listMcpTools(db: Db, serverId: string): Promise<McpToolRow[]> {
  if (!UUID.test(serverId)) return [];
  return db.query<McpToolRow>(
    `select * from mcp_server_tools where server_id = $1 order by tool_name`,
    [serverId],
  );
}

export async function mcpToolById(db: Db, id: string): Promise<McpToolRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<McpToolRow>(`select * from mcp_server_tools where id = $1`, [id]);
  return rows[0] ?? null;
}

export interface McpDiscoveryOutcome {
  added: number;
  /** Approved tools whose definition changed. Each one has been taken OFF the
   * allowlist and is named back to the owner, because "three of your tools were
   * silently switched off" is not something to leave somebody to notice. */
  changed: string[];
  /** Tools the server no longer offers. Kept, so the owner's decision survives
   * a server being briefly odd, but not offered. */
  disappeared: string[];
  total: number;
}

/**
 * Applies one discovery to the allowlist.
 *
 * DISCOVERY WRITES ROWS AND GRANTS NOTHING. Every new tool arrives at `new`.
 * Every previously approved tool whose definition changed goes to `changed`,
 * which is off. A tool the server stopped offering is marked unavailable rather
 * than deleted, so the decision somebody made about it is not quietly undone by
 * a server having a bad afternoon.
 *
 * A REVOKED TOOL STAYS REVOKED even when its definition changes. The owner said
 * no to a name on that server; re-offering it as new because its description
 * moved would be the far end deciding when to ask again.
 */
export async function reconcileMcpTools(
  db: Db,
  args: { actorUserId: string; server: McpServerRow; tools: DiscoveredMcpTool[] },
): Promise<McpDiscoveryOutcome> {
  const existing = await listMcpTools(db, args.server.id);
  const byName = new Map(existing.map((row) => [row.tool_name, row] as const));
  const seen = new Set<string>();
  const outcome: McpDiscoveryOutcome = { added: 0, changed: [], disappeared: [], total: args.tools.length };

  for (const tool of args.tools) {
    seen.add(tool.name);
    const digest = toolDigest(tool);
    const before = byName.get(tool.name);

    if (!before) {
      await db.query(
        `insert into mcp_server_tools
           (server_id, tool_name, title, description, input_schema, server_read_only_hint,
            definition_digest)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (server_id, tool_name) do nothing`,
        [
          args.server.id, tool.name, tool.title, tool.description,
          // `json()`, never a hand-serialised string: postgres.js types a
          // string as text, so a pre-stringified object reaches jsonb as a
          // scalar string. Invisible under pglite, permanent in production.
          json(tool.inputSchema), tool.readOnlyHint, digest,
        ],
      );
      outcome.added++;
      continue;
    }

    const definitionChanged = before.definition_digest !== digest;
    // The one state transition a remote server can cause. Approved plus a new
    // definition is a different tool wearing an approved name.
    const nextState: McpToolState = definitionChanged && before.state === 'approved'
      ? 'changed'
      : before.state;
    if (definitionChanged && before.state === 'approved') outcome.changed.push(tool.name);

    await db.query(
      `update mcp_server_tools set
         title = $2, description = $3, input_schema = $4, server_read_only_hint = $5,
         definition_digest = $6, state = $7, available = true, last_seen_at = now()
       where id = $1`,
      [
        before.id, tool.title, tool.description, json(tool.inputSchema), tool.readOnlyHint,
        digest, nextState,
      ],
    );
  }

  for (const row of existing) {
    if (seen.has(row.tool_name)) continue;
    if (row.available) outcome.disappeared.push(row.tool_name);
    await db.query(`update mcp_server_tools set available = false where id = $1`, [row.id]);
  }

  await db.query(`update mcp_servers set last_discovery_at = now() where id = $1`, [args.server.id]);
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: 'mcp.tools_discovered',
    subjectType: 'mcp_server',
    subjectId: args.server.id,
    // Counts and the server's slug. Never a tool name, never a description:
    // both are a remote party's words about somebody's own account.
    payload: {
      slug: args.server.slug,
      offered: outcome.total,
      added: outcome.added,
      changedAfterApproval: outcome.changed.length,
      noLongerOffered: outcome.disappeared.length,
    },
  });
  return outcome;
}

/**
 * The owner's decision about one tool.
 *
 * `approved` is only reachable when the definition the caller saw is the
 * definition on the row: the route passes the digest it showed, and a mismatch
 * refuses. Without that, a server could change a tool between the page being
 * rendered and the button being pressed, and the approval would land on words
 * nobody read.
 */
export async function setMcpToolDecision(
  db: Db,
  args: {
    actorUserId: string;
    server: McpServerRow;
    tool: McpToolRow;
    state: McpToolState;
    approvalMode?: McpApprovalMode;
    /** What the owner was looking at. Required to approve. */
    seenDigest?: string;
  },
): Promise<McpToolRow> {
  if (args.state === 'changed') {
    throw new McpInputError('that is not a decision — it is what Josi does when a server changes a tool');
  }
  if (args.state === 'approved') {
    if (!args.tool.available) {
      throw new McpInputError('that server no longer offers this tool, so there is nothing to switch on');
    }
    if (args.seenDigest && args.seenDigest !== args.tool.definition_digest) {
      throw new McpInputError(
        'this tool changed while you were looking at it. Read the new description and decide again.',
      );
    }
  }
  const approvalMode = args.approvalMode ?? args.tool.approval_mode;
  const rows = await db.query<McpToolRow>(
    `update mcp_server_tools set state = $2, approval_mode = $3, decided_at = now()
      where id = $1 returning *`,
    [args.tool.id, args.state, approvalMode],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'user',
    kind: args.state === 'approved' ? 'mcp.tool_approved' : 'mcp.tool_revoked',
    subjectType: 'mcp_server_tool',
    subjectId: args.tool.id,
    // The slug and whether it needs asking. NOT the tool name: on somebody's
    // own notes or health server, the names of the tools they turned on are a
    // fact about them, and an audit row is readable by an administrator.
    payload: { slug: args.server.slug, approvalMode },
  });
  return rows[0];
}

// ------------------------------------------------------- what the model sees

export interface AvailableMcpTool {
  server: McpServerRow;
  tool: McpToolRow;
}

/**
 * Every external tool this person's assistant may currently choose from: an
 * APPROVED, AVAILABLE tool under an ENABLED server they own, and nothing else.
 *
 * Owner-scoped in the query rather than filtered afterwards. There is no
 * argument here a caller could widen, so one person's approved tools can never
 * appear in another person's turn.
 */
export async function availableMcpTools(db: Db, ownerUserId: string): Promise<AvailableMcpTool[]> {
  const rows = await db.query<McpToolRow & McpServerRow & { tool_id: string; server_row_id: string }>(
    `select t.id as tool_id, t.server_id, t.tool_name, t.title, t.description, t.input_schema,
            t.server_read_only_hint, t.definition_digest, t.state, t.approval_mode, t.available,
            t.first_seen_at, t.last_seen_at, t.decided_at, t.created_at, t.updated_at,
            s.id as server_row_id, s.owner_user_id, s.name, s.slug, s.endpoint_url, s.host,
            s.auth_kind, s.auth_header, s.credentials_enc, s.enabled, s.status,
            s.last_check_at, s.last_check_ok, s.last_error_category, s.protocol_version,
            s.server_label, s.last_discovery_at
       from mcp_server_tools t
       join mcp_servers s on s.id = t.server_id
      where s.owner_user_id = $1 and s.enabled and t.state = 'approved' and t.available
      order by s.slug, t.tool_name`,
    [ownerUserId],
  );
  return rows.map((row) => splitJoinedRow(row));
}

/** One named tool, re-resolved at the moment of use.
 *
 * The lookup is by (owner, slug, tool name) against the APPROVED set, so a
 * switch flipped between the model being offered a tool and the model calling
 * it refuses — the offering is never the authority.
 */
export async function resolveMcpTool(
  db: Db,
  args: { ownerUserId: string; slug: string; toolName: string },
): Promise<AvailableMcpTool | null> {
  const rows = await db.query<McpToolRow & McpServerRow & { tool_id: string; server_row_id: string }>(
    `select t.id as tool_id, t.server_id, t.tool_name, t.title, t.description, t.input_schema,
            t.server_read_only_hint, t.definition_digest, t.state, t.approval_mode, t.available,
            t.first_seen_at, t.last_seen_at, t.decided_at, t.created_at, t.updated_at,
            s.id as server_row_id, s.owner_user_id, s.name, s.slug, s.endpoint_url, s.host,
            s.auth_kind, s.auth_header, s.credentials_enc, s.enabled, s.status,
            s.last_check_at, s.last_check_ok, s.last_error_category, s.protocol_version,
            s.server_label, s.last_discovery_at
       from mcp_server_tools t
       join mcp_servers s on s.id = t.server_id
      where s.owner_user_id = $1 and s.slug = $2 and t.tool_name = $3
        and s.enabled and t.state = 'approved' and t.available`,
    [args.ownerUserId, args.slug, args.toolName],
  );
  return rows.length ? splitJoinedRow(rows[0]) : null;
}

/** One flat join row back into the two rows it came from. The aliases exist
 * because both tables have `id`, `created_at` and `updated_at`, and a `select *`
 * across the join silently keeps one of each. */
function splitJoinedRow(
  row: McpToolRow & McpServerRow & { tool_id: string; server_row_id: string },
): AvailableMcpTool {
  return {
    server: {
      id: row.server_row_id,
      owner_user_id: row.owner_user_id,
      name: row.name,
      slug: row.slug,
      endpoint_url: row.endpoint_url,
      host: row.host,
      auth_kind: row.auth_kind,
      auth_header: row.auth_header,
      credentials_enc: row.credentials_enc,
      enabled: row.enabled,
      status: row.status,
      last_check_at: row.last_check_at,
      last_check_ok: row.last_check_ok,
      last_error_category: row.last_error_category,
      protocol_version: row.protocol_version,
      server_label: row.server_label,
      last_discovery_at: row.last_discovery_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
    tool: {
      id: row.tool_id,
      server_id: row.server_id,
      tool_name: row.tool_name,
      title: row.title,
      description: row.description,
      input_schema: row.input_schema ?? {},
      server_read_only_hint: row.server_read_only_hint,
      definition_digest: row.definition_digest,
      state: row.state,
      approval_mode: row.approval_mode,
      available: row.available,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      decided_at: row.decided_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    },
  };
}

// ------------------------------------------------------ the administrator's ceiling

export interface McpPolicy {
  allowed: boolean;
  note: string | null;
  /** Empty = no host restriction beyond the public-internet rule. Non-empty =
   * only these hosts. It narrows and never widens. */
  allowedHosts: string[];
}

export async function mcpPolicy(db: Db): Promise<McpPolicy> {
  const rows = await db.query<{ allowed: boolean; note: string | null; allowed_hosts: unknown }>(
    `select allowed, note, allowed_hosts from mcp_policy where id = true`,
  );
  const row = rows[0];
  const hosts = Array.isArray(row?.allowed_hosts) ? row.allowed_hosts : [];
  return {
    allowed: row?.allowed ?? true,
    note: row?.note ?? null,
    allowedHosts: hosts.filter((h): h is string => typeof h === 'string'),
  };
}

/** A host list an administrator typed, normalised.
 *
 * Hostnames only. A URL, a path or a port here would produce a list that looks
 * like it restricts something and does not, because the comparison is against
 * `mcp_servers.host` — a hostname. Saying so beats accepting a value that
 * silently never matches. */
export function validateMcpAllowedHosts(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : [];
  if (list.length > 50) throw new McpInputError('that is more hosts than this list will hold');
  const out: string[] = [];
  for (const item of list) {
    const host = text(item).toLowerCase();
    if (!host) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
      throw new McpInputError(
        `"${host.slice(0, 60)}" is not a hostname. List hosts such as mcp.example.com — not a full `
        + 'address, a path or a port.',
      );
    }
    if (!out.includes(host)) out.push(host);
  }
  return out;
}

export async function setMcpPolicy(
  db: Db,
  args: { actorUserId: string; allowed: boolean; note: string | null; allowedHosts: string[] },
): Promise<McpPolicy> {
  await db.query(
    `update mcp_policy set allowed = $1, note = $2, allowed_hosts = $3 where id = true`,
    [args.allowed, args.note, json(args.allowedHosts)],
  );
  await appendEvent(db, {
    actorUserId: args.actorUserId,
    actor: 'super_admin',
    kind: args.allowed ? 'mcp.permitted' : 'mcp.forbidden',
    payload: { hostsListed: args.allowedHosts.length },
  });
  return mcpPolicy(db);
}

/** The ceiling, applied.
 *
 * Checked on every route that CONTACTS a server, not only on the one that
 * stores it: a feature switched off after somebody connected would otherwise
 * carry on being exercised, and "switched off for this installation" would mean
 * "switched off for people who had not got round to it yet". Listing, disabling
 * and removing stay available — a ceiling must never trap somebody's live token
 * inside Josi with no way to take it back.
 */
export function policyRefusal(policy: McpPolicy, host: string): string | null {
  if (!policy.allowed) {
    return policy.note
      ? `An administrator has switched MCP servers off for this installation: ${policy.note}`
      : 'An administrator has switched MCP servers off for this installation.';
  }
  if (policy.allowedHosts.length && !policy.allowedHosts.includes(host)) {
    return `An administrator has limited MCP servers to: ${policy.allowedHosts.join(', ')}.`;
  }
  return null;
}
