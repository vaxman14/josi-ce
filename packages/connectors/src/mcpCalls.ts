// The approval gate for MCP tools that are not marked read-only.
//
// The same mechanism as a Custom API write (customApiCalls.ts), for the same
// reasons: the call becomes a row only its owner can see or decide, the
// arguments are sealed, a hash pins the approval to this exact call, and one
// conditional UPDATE makes "approve" happen once however many times the
// button is pressed.
//
// One thing is added. A Custom API answer goes to the person who approved it
// and stops there. An MCP tool is usually called in the middle of a
// conversation that wants the answer, so the answer is kept — sealed, once —
// and handed to the conversation the next time it asks for the very same
// call. It is handed over one time and then erased.
import {
  appendEvent, approvalHash, openSealed, seal,
  type Db, type MasterKey,
} from '@josi-ce/core';
import { cleanMcpLine, type McpToolResult } from './mcpClient.js';
import type { McpConnectionRow } from './mcpConnections.js';

/** How long an unanswered request stays answerable. An old request is not
 * consent. */
export const MCP_PENDING_TTL_SECONDS = 30 * 60;
/** How long an approved call's answer waits to be collected. */
const RESULT_KEPT_SECONDS = 30 * 60;

export interface McpPendingCallRow {
  id: string;
  owner_user_id: string;
  connection_id: string;
  thread_id: string | null;
  tool_name: string;
  summary: string;
  request_enc: string;
  payload_hash: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  decided_at: string | null;
  decided_by: string | null;
  executed_at: string | null;
  result_enc: string | null;
  result_delivered_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
}

/** A refusal about a pending request. `notFound` covers "not yours" too:
 * saying a request exists but belongs to somebody else confirms a colleague
 * asked for something. */
export class McpCallError extends Error {
  constructor(message: string, readonly notFound = false) { super(message); }
}

/** What is sealed and what the hash pins: which connection, at which address,
 * which tool, with exactly which arguments. The address is included so a
 * connection cannot be pointed somewhere else between "may I?" and "yes". */
export interface SealedMcpCall {
  connectionId: string;
  url: string;
  tool: string;
  arguments: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function sealedMcpCall(connection: McpConnectionRow, tool: string, args: Record<string, unknown>): SealedMcpCall {
  return { connectionId: connection.id, url: connection.url, tool, arguments: args };
}

/** The sentence the owner reads before they agree. Written from the stored
 * connection and the arguments, never from anything the model or the server
 * said about them. */
export function describeMcpCall(connection: McpConnectionRow, tool: string, args: Record<string, unknown>): string {
  const show = (value: unknown): string => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
    return cleanMcpLine(raw, 80);
  };
  const entries = Object.entries(args).filter(([, v]) => v !== undefined && v !== null && v !== '');
  const supplied = entries.slice(0, 12).map(([k, v]) => `${cleanMcpLine(k, 40)}: ${show(v)}`);
  return [
    `Josi wants to use the tool "${cleanMcpLine(tool, 80)}" on ${connection.name} (${connection.host}).`,
    'This tool is not marked as read-only, so it may change, send or delete something there.',
    supplied.length ? `With: ${supplied.join(', ')}${entries.length > 12 ? `, and ${entries.length - 12} more` : ''}` : 'With no extra details.',
  ].join(' ').slice(0, 2000);
}

/** Records a call that is waiting on its owner. A second identical request
 * while the first is still waiting updates it rather than adding a card. */
export async function requestMcpCall(db: Db, key: MasterKey, args: {
  ownerUserId: string; threadId?: string | null; connection: McpConnectionRow; tool: string;
  arguments: Record<string, unknown>; ttlSeconds?: number;
}): Promise<McpPendingCallRow> {
  const payload = sealedMcpCall(args.connection, args.tool, args.arguments);
  const [row] = await db.query<McpPendingCallRow>(
    `insert into mcp_pending_calls
       (owner_user_id, connection_id, thread_id, tool_name, summary, request_enc, payload_hash, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(secs => $8::int))
     on conflict (owner_user_id, connection_id, payload_hash) where status = 'pending'
       do update set summary = excluded.summary, expires_at = excluded.expires_at
     returning *`,
    [
      args.ownerUserId, args.connection.id, args.threadId ?? null, args.tool,
      describeMcpCall(args.connection, args.tool, args.arguments), seal(key, payload), approvalHash(payload),
      args.ttlSeconds ?? MCP_PENDING_TTL_SECONDS,
    ]);
  // The phone is told the same way it is told about any approval: that one is
  // waiting, and nothing about what it says. Once per request, and only to
  // devices that have not switched approval notices off.
  await db.query(
    `insert into push_deliveries (owner_user_id, device_id, event_key, category, route_type, route_id, title, body)
     select d.owner_user_id, d.id, $2, 'approval', 'approval', $3, 'Josi', 'Your approval is needed.'
       from mobile_devices d
      where d.owner_user_id = $1 and d.revoked_at is null and d.app_state <> 'foreground'
        and coalesce((d.categories->>'approval')::boolean, true)
     on conflict (device_id, event_key) do nothing`,
    [args.ownerUserId, `mcp_call:${row.id}`, row.id]);
  await appendEvent(db, {
    actorUserId: args.ownerUserId, actor: 'agent', kind: 'mcp.call_requested',
    subjectType: 'mcp_pending_call', subjectId: row.id,
    // Which server and which tool. Never the arguments, never the summary.
    payload: { slug: args.connection.slug, tool: cleanMcpLine(args.tool, 128) },
  });
  return row;
}

export async function listPendingMcpCalls(db: Db, ownerUserId: string): Promise<Array<McpPendingCallRow & { connection_name: string; slug: string; host: string }>> {
  return db.query(
    `select p.*, c.name as connection_name, c.slug, c.host
       from mcp_pending_calls p join mcp_connections c on c.id = p.connection_id
      where p.owner_user_id = $1 and p.status = 'pending' and p.expires_at > now()
      order by p.created_at desc limit 100`, [ownerUserId]);
}

export async function mcpPendingCallById(db: Db, id: string): Promise<McpPendingCallRow | null> {
  if (!UUID.test(id)) return null;
  const [row] = await db.query<McpPendingCallRow>('select * from mcp_pending_calls where id = $1', [id]);
  return row ?? null;
}

/** Claims a pending request for execution, atomically. `decidedBy` must be the
 * owner; there is no role that may decide for somebody else. */
export async function claimApprovedMcpCall(db: Db, args: { callId: string; decidedBy: string }): Promise<McpPendingCallRow> {
  const existing = await mcpPendingCallById(db, args.callId);
  if (!existing || existing.owner_user_id !== args.decidedBy) throw new McpCallError('there is no request with that id', true);
  if (existing.status !== 'pending') throw new McpCallError(`that request was already ${existing.status}`);
  if (new Date(existing.expires_at) < new Date()) {
    await db.query(`update mcp_pending_calls set status = 'expired' where id = $1 and status = 'pending'`, [args.callId]);
    throw new McpCallError('that request expired. Ask again and Josi will prepare a fresh one — an old request is not consent.');
  }
  const rows = await db.query<McpPendingCallRow>(
    `update mcp_pending_calls set status = 'approved', decided_at = now(), decided_by = $2
      where id = $1 and status = 'pending' and expires_at > now() returning *`,
    [args.callId, args.decidedBy]);
  if (!rows.length) throw new McpCallError('that request was already decided');
  await appendEvent(db, {
    actorUserId: args.decidedBy, actor: 'user', kind: 'mcp.call_approved',
    subjectType: 'mcp_pending_call', subjectId: args.callId,
  });
  return rows[0];
}

export async function denyMcpCall(db: Db, args: { callId: string; decidedBy: string }): Promise<McpPendingCallRow> {
  const existing = await mcpPendingCallById(db, args.callId);
  if (!existing || existing.owner_user_id !== args.decidedBy) throw new McpCallError('there is no request with that id', true);
  const rows = await db.query<McpPendingCallRow>(
    `update mcp_pending_calls set status = 'denied', decided_at = now(), decided_by = $2
      where id = $1 and status = 'pending' returning *`,
    [args.callId, args.decidedBy]);
  if (!rows.length) throw new McpCallError(`that request was already ${existing.status}`);
  await appendEvent(db, {
    actorUserId: args.decidedBy, actor: 'user', kind: 'mcp.call_denied',
    subjectType: 'mcp_pending_call', subjectId: args.callId,
  });
  return rows[0];
}

/** Opens the sealed call and checks it is still the one that was approved. */
export function openApprovedMcpCall(key: MasterKey, row: McpPendingCallRow): SealedMcpCall {
  const payload = openSealed<SealedMcpCall>(key, row.request_enc);
  if (approvalHash(payload) !== row.payload_hash || payload.connectionId !== row.connection_id) {
    throw new McpCallError('that request no longer matches what was approved, so Josi did not run it');
  }
  return payload;
}

/** What happened. The tool's answer is sealed for its owner's conversation;
 * the audit record carries no answer at all. */
export async function recordMcpCallResult(db: Db, key: MasterKey, args: {
  callId: string; ownerUserId: string; slug: string; tool: string; ok: boolean; result?: McpToolResult | null;
}): Promise<void> {
  await db.query(
    `update mcp_pending_calls set status = $2, executed_at = now(), result_enc = $3 where id = $1`,
    [args.callId, args.ok ? 'executed' : 'failed', args.result ? seal(key, args.result) : null]);
  await appendEvent(db, {
    actorUserId: args.ownerUserId, actor: 'user', kind: args.ok ? 'mcp.call_executed' : 'mcp.call_failed',
    subjectType: 'mcp_pending_call', subjectId: args.callId,
    payload: { slug: args.slug, tool: cleanMcpLine(args.tool, 128) },
  });
}

/**
 * The answer to a call this person already approved, for the conversation
 * that asked for it — or null.
 *
 * Matched on the same hash the approval pinned, so only the very same call
 * (same server, same tool, same arguments) collects it. Handed over once and
 * erased: asking a third time is a new request and a new question.
 */
export async function takeMcpCallResult(db: Db, key: MasterKey, args: {
  ownerUserId: string; connection: McpConnectionRow; tool: string; arguments: Record<string, unknown>;
}): Promise<{ status: 'executed' | 'failed' | 'denied'; result: McpToolResult | null } | null> {
  const hash = approvalHash(sealedMcpCall(args.connection, args.tool, args.arguments));
  const take = async (tx: Db) => {
    const [row] = await tx.query<McpPendingCallRow>(
      `select * from mcp_pending_calls
        where owner_user_id = $1 and connection_id = $2 and payload_hash = $3
          and status in ('executed', 'failed', 'denied') and result_delivered_at is null
          and coalesce(executed_at, decided_at) > now() - make_interval(secs => $4::int)
        order by coalesce(executed_at, decided_at) desc limit 1 for update`,
      [args.ownerUserId, args.connection.id, hash, RESULT_KEPT_SECONDS]);
    if (!row) return null;
    // Marked delivered in the same transaction that read it, so two turns
    // asking at once cannot both be given the answer.
    const claimed = await tx.query(
      `update mcp_pending_calls set result_delivered_at = now(), result_enc = null
        where id = $1 and result_delivered_at is null returning id`, [row.id]);
    if (!claimed.length) return null;
    let result: McpToolResult | null = null;
    if (row.result_enc) {
      try { result = openSealed<McpToolResult>(key, row.result_enc); } catch { result = null; }
    }
    return { status: row.status as 'executed' | 'failed' | 'denied', result };
  };
  return db.transaction ? db.transaction(take) : take(db);
}

/** Expires requests nobody answered and erases answers nobody collected. Run
 * by the worker, beside `expireCustomApiCalls`. */
export async function expireMcpCalls(db: Db): Promise<number> {
  await db.query(
    `update mcp_pending_calls set result_enc = null
      where result_enc is not null and executed_at < now() - make_interval(secs => $1::int)`, [RESULT_KEPT_SECONDS]);
  const rows = await db.query<{ id: string }>(
    `update mcp_pending_calls set status = 'expired' where status = 'pending' and expires_at < now() returning id`);
  return rows.length;
}
