// The approval gate for external MCP tool calls.
//
// A tool the owner marked "ask me" never runs because a model decided to. It
// becomes a row in `mcp_pending_calls`, its owner is shown exactly what would
// be sent, and the call is made only after they say so — once, for that exact
// call.
//
// WHY THIS IS NOT `customApiCalls.ts` WITH A DIFFERENT FOREIGN KEY
//
// It is the same MECHANISM, and that is on purpose: a pinned payload hash, one
// conditional UPDATE that claims the row, one route that decides and calls in
// the same breath, so an approved call can neither sit unmade nor be made
// twice. Everything below is that pattern applied again rather than reinvented.
//
// What differs is what is being described. There, the summary is written from
// an allowlist row an ADMINISTRATOR typed, and the risk is that the model
// misrepresents it. Here the tool's own description was written by the REMOTE
// SERVER, so the summary quotes it as a claim — "the server describes it as" —
// rather than asserting it. A sentence a stranger wrote must not be rendered as
// Josi's account of what is about to happen.
//
// WHAT IS AND IS NOT STORED
//
//   * The arguments are SEALED. What Josi is about to send to somebody's notes
//     app is their data, and it has no business being readable in a database
//     dump while it waits for an answer.
//   * The summary is CONTENT — it quotes what is about to be sent — so it
//     belongs to its owner and is never copied into an audit payload.
//   * The result is a BOOLEAN. Never the server's answer.
import { appendEvent, approvalHash, openSealed, seal, type Db, type MasterKey } from '@josi-ce/core';
import type { McpPendingCallRow, McpServerRow, McpToolRow } from './mcpServers.js';

/** How long an unanswered call stays answerable.
 *
 * Thirty minutes, matching the custom API gate and for the same reason: long
 * enough to walk away from the screen and come back, short enough that nobody
 * is ever shown a request from a conversation they no longer remember. A
 * pending call from last month is not consent. */
export const MCP_PENDING_CALL_TTL_SECONDS = 30 * 60;

/** A refusal about a pending call.
 *
 * `notFound` is carried on the error rather than decided by the route, because
 * the route would have to match on a message to tell "not yours" from "already
 * decided" — and those two must answer differently. A call belonging to
 * somebody else is 404, exactly like one that never existed: 403 would confirm
 * that a colleague asked Josi for something. */
export class McpCallError extends Error {
  constructor(message: string, readonly notFound = false) {
    super(message);
  }
}

/** What gets sealed and what the hash pins.
 *
 * The server id and the tool name are included deliberately: pinning only the
 * arguments would let a row be edited between "may I?" and "yes" and turn an
 * approved read on one server into a write on another. */
export interface SealedMcpRequest {
  serverId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

const UUID = /^[0-9a-fA-F-]{36}$/;

/**
 * The sentence the owner reads before they agree.
 *
 * Written from the ROW and the arguments, not from anything the model said
 * about them: a model asked to describe its own action can describe a gentler
 * one. The tool's description is quoted AS THE SERVER'S CLAIM, because that is
 * what it is — a stranger's sentence about a stranger's software, and rendering
 * it as Josi's own account of what will happen would be Josi vouching for it.
 */
export function describeMcpCall(args: {
  server: McpServerRow;
  tool: McpToolRow;
  arguments: Record<string, unknown>;
}): string {
  const supplied = Object.entries(args.arguments)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}: ${(typeof v === 'string' ? v : JSON.stringify(v)).slice(0, 80)}`);

  const described = args.tool.description || args.tool.title || '';
  return [
    `Josi wants to run "${args.tool.tool_name}" on ${args.server.name}.`,
    described ? `That server describes it as: ${described}` : 'That server gave it no description.',
    supplied.length ? `With: ${supplied.join(', ')}` : 'With no details.',
    'Josi cannot see what that tool actually does — only what the server says about it.',
  ].filter(Boolean).join(' ').slice(0, 2000);
}

/**
 * Records a call that is waiting on its owner.
 *
 * Idempotent for the same person, tool and payload: the unique index on
 * (owner, tool, payload_hash) where status = 'pending' means a second identical
 * "shall I?" updates the existing row rather than adding a second card. Two
 * identical prompts is a bug that trains people to click yes.
 */
export async function requestMcpCall(
  db: Db,
  key: MasterKey,
  args: {
    ownerUserId: string;
    threadId?: string | null;
    server: McpServerRow;
    tool: McpToolRow;
    arguments: Record<string, unknown>;
    summary: string;
    ttlSeconds?: number;
  },
): Promise<McpPendingCallRow> {
  const payload: SealedMcpRequest = {
    serverId: args.server.id,
    toolName: args.tool.tool_name,
    arguments: args.arguments,
  };
  const hash = approvalHash(payload);
  const rows = await db.query<McpPendingCallRow>(
    `insert into mcp_pending_calls
       (owner_user_id, tool_id, thread_id, summary, request_enc, payload_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7::int))
     on conflict (owner_user_id, tool_id, payload_hash) where status = 'pending'
       do update set summary = excluded.summary, expires_at = excluded.expires_at
     returning *`,
    [
      args.ownerUserId, args.tool.id, args.threadId ?? null, args.summary,
      seal(key, payload), hash, args.ttlSeconds ?? MCP_PENDING_CALL_TTL_SECONDS,
    ],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'agent',
    kind: 'mcp.call_requested',
    subjectType: 'mcp_pending_call',
    subjectId: rows[0].id,
    // Which server. Never the tool name, never the arguments, never the
    // summary: the summary is what the call WOULD say and it stays with its
    // owner, and on somebody's own notes or health server a tool name is a fact
    // about them.
    payload: { slug: args.server.slug },
  });
  return rows[0];
}

/** Somebody's own pending calls. Owner-scoped by the query, so there is no id
 * for a caller to substitute. */
export async function listPendingMcpCalls(
  db: Db,
  ownerUserId: string,
): Promise<Array<McpPendingCallRow & { tool_name: string; server_name: string; slug: string }>> {
  return db.query(
    `select p.*, t.tool_name, s.name as server_name, s.slug
       from mcp_pending_calls p
       join mcp_server_tools t on t.id = p.tool_id
       join mcp_servers s on s.id = t.server_id
      where p.owner_user_id = $1 and p.status = 'pending' and p.expires_at > now()
      order by p.created_at desc
      limit 100`,
    [ownerUserId],
  );
}

export async function pendingMcpCallById(db: Db, id: string): Promise<McpPendingCallRow | null> {
  if (!UUID.test(id)) return null;
  const rows = await db.query<McpPendingCallRow>(
    `select * from mcp_pending_calls where id = $1`, [id],
  );
  return rows[0] ?? null;
}

/**
 * Claims a pending call for execution, atomically.
 *
 * The whole "exactly once" guarantee is this one statement. `status = 'pending'`
 * in the WHERE clause means two concurrent approvals — two browser tabs, a
 * double-tapped button, a retried request — produce one row and one null, and
 * the caller that got null makes no call.
 *
 * `decidedBy` must be the OWNER, and there is no role branch here for one to be
 * added to. An administrator does not get to decide what somebody's assistant
 * sends to their own notes app.
 */
export async function claimApprovedMcpCall(
  db: Db,
  args: { callId: string; decidedBy: string },
): Promise<McpPendingCallRow> {
  const existing = await pendingMcpCallById(db, args.callId);
  // Same sentence AND the same status as "does not exist": telling somebody a
  // call exists but is not theirs confirms a colleague asked for something.
  if (!existing || existing.owner_user_id !== args.decidedBy) {
    throw new McpCallError('there is no request with that id', true);
  }
  if (existing.status !== 'pending') {
    throw new McpCallError(`that request was already ${existing.status}`);
  }
  if (new Date(existing.expires_at) < new Date()) {
    await db.query(
      `update mcp_pending_calls set status = 'expired' where id = $1 and status = 'pending'`,
      [args.callId],
    );
    throw new McpCallError(
      'that request expired. Ask again and Josi will prepare a fresh one — an old request is not consent.',
    );
  }

  const rows = await db.query<McpPendingCallRow>(
    `update mcp_pending_calls
        set status = 'approved', decided_at = now(), decided_by = $2
      where id = $1 and status = 'pending' and expires_at > now()
      returning *`,
    [args.callId, args.decidedBy],
  );
  if (!rows.length) throw new McpCallError('that request was already decided');

  await appendEvent(db, {
    actorUserId: args.decidedBy,
    actor: 'user',
    kind: 'mcp.call_approved',
    subjectType: 'mcp_pending_call',
    subjectId: args.callId,
  });
  return rows[0];
}

export async function denyMcpCall(
  db: Db,
  args: { callId: string; decidedBy: string },
): Promise<McpPendingCallRow> {
  const existing = await pendingMcpCallById(db, args.callId);
  if (!existing || existing.owner_user_id !== args.decidedBy) {
    throw new McpCallError('there is no request with that id', true);
  }
  const rows = await db.query<McpPendingCallRow>(
    `update mcp_pending_calls
        set status = 'denied', decided_at = now(), decided_by = $2
      where id = $1 and status = 'pending'
      returning *`,
    [args.callId, args.decidedBy],
  );
  if (!rows.length) throw new McpCallError(`that request was already ${existing.status}`);
  await appendEvent(db, {
    actorUserId: args.decidedBy,
    actor: 'user',
    kind: 'mcp.call_denied',
    subjectType: 'mcp_pending_call',
    subjectId: args.callId,
  });
  return rows[0];
}

/**
 * Opens the sealed call and checks it is still the one that was approved.
 *
 * The hash is re-verified rather than trusted, because the row was written by
 * one code path and is being read by another — and a sealed value that opens is
 * only proof that the master key sealed it, not proof of which call it was.
 */
export function openApprovedMcpRequest(key: MasterKey, row: McpPendingCallRow): SealedMcpRequest {
  const payload = openSealed<SealedMcpRequest>(key, row.request_enc);
  if (approvalHash(payload) !== row.payload_hash) {
    throw new McpCallError('that request no longer matches what was approved, so Josi did not make it');
  }
  return payload;
}

/** What happened. A boolean, never the server's answer. */
export async function recordMcpCallResult(
  db: Db,
  args: { callId: string; ownerUserId: string; ok: boolean; slug: string },
): Promise<void> {
  await db.query(
    `update mcp_pending_calls set status = $2, executed_at = now(), result_ok = $3 where id = $1`,
    [args.callId, args.ok ? 'executed' : 'failed', args.ok],
  );
  await appendEvent(db, {
    actorUserId: args.ownerUserId,
    actor: 'user',
    kind: args.ok ? 'mcp.call_executed' : 'mcp.call_failed',
    subjectType: 'mcp_pending_call',
    subjectId: args.callId,
    payload: { slug: args.slug },
  });
}

/** Expires calls nobody answered. Run by the worker, beside `expireApprovals`
 * and `expireCustomApiCalls`. */
export async function expireMcpCalls(db: Db): Promise<number> {
  const rows = await db.query<{ id: string }>(
    `update mcp_pending_calls set status = 'expired'
      where status = 'pending' and expires_at < now()
      returning id`,
  );
  return rows.length;
}
