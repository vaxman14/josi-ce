// One-time tickets that let a native app add a passkey through the system browser.
//
// The app proves the password, and the browser, which holds no session, proves
// nothing more than having the ticket. So a ticket is short-lived, spent once
// whether or not the passkey then verifies, and tied to one person and to the
// `state` it was issued with.
//
// Rows live in auth_passkey_challenges as purpose 'register'. Their key starts
// `ticket:`, so a ticket can never be spent as a WebAuthn challenge, whose key is
// always bare hex, and a challenge can never be read as a ticket. auth_tokens
// would not do: consumeAuthToken ignores purpose, so a ticket there would open
// the set-password route.
//
// That table has no column for the device label, so the label rides inside the
// ticket. The stored hash covers it, which means it cannot be changed on the way.
import { createHash, randomBytes } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';

export const PASSKEY_TICKET_TTL_SECONDS = 5 * 60;

const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{1,512}$/;

const ticketKey = (ticket: string, state: string) => `ticket:${createHash('sha256').update(`${state}\n${ticket}`).digest('hex')}`;

export interface PasskeyTicket { userId: string; name: string }

/** The label as it will be saved, or null when it cannot be one. */
export function passkeyLabel(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim().slice(0, 80) : '';
  return name && !/[\u0000-\u001f\u007f]/.test(name) ? name : null;
}

const nameIn = (ticket: string) => Buffer.from(ticket.slice(ticket.indexOf('.') + 1), 'base64url').toString('utf8');

/** A new ticket replaces any this person still holds. */
export async function issuePasskeyTicket(db: Db, args: { userId: string; name: string; state: string; ip: string | null }): Promise<string> {
  const ticket = `${randomBytes(32).toString('base64url')}.${Buffer.from(args.name, 'utf8').toString('base64url')}`;
  await db.query(
    `update auth_passkey_challenges set used_at = now()
     where user_id = $1 and purpose = 'register' and used_at is null and challenge_hash like 'ticket:%'`,
    [args.userId],
  );
  await db.query(
    `insert into auth_passkey_challenges (challenge_hash, purpose, user_id, ip, expires_at) values ($1, 'register', $2, $3, now() + make_interval(secs => $4))`,
    [ticketKey(ticket, args.state), args.userId, args.ip, PASSKEY_TICKET_TTL_SECONDS],
  );
  await appendEvent(db, { actorUserId: args.userId, actor: 'user', kind: 'auth.passkey_add_ticket_issued', subjectType: 'user', subjectId: args.userId });
  return ticket;
}

/** Looks without spending, so opening the page costs nothing. */
export async function readPasskeyTicket(db: Db, ticket: string, state: string): Promise<PasskeyTicket | null> {
  if (!TICKET_SHAPE.test(ticket)) return null;
  const [row] = await db.query<{ user_id: string }>(
    `select c.user_id from auth_passkey_challenges c join users u on u.id = c.user_id
     where c.challenge_hash = $1 and c.purpose = 'register' and c.used_at is null and c.expires_at > now() and u.status = 'active'`,
    [ticketKey(ticket, state)],
  );
  return row ? { userId: row.user_id, name: nameIn(ticket) } : null;
}

/** Spends it. The conditions sit in the UPDATE, so two racing calls cannot both win. */
export async function spendPasskeyTicket(db: Db, ticket: string, state: string): Promise<PasskeyTicket | null> {
  if (!TICKET_SHAPE.test(ticket)) return null;
  const [row] = await db.query<{ user_id: string }>(
    `update auth_passkey_challenges c set used_at = now()
     from users u
     where u.id = c.user_id and u.status = 'active'
       and c.challenge_hash = $1 and c.purpose = 'register' and c.used_at is null and c.expires_at > now()
     returning c.user_id`,
    [ticketKey(ticket, state)],
  );
  return row ? { userId: row.user_id, name: nameIn(ticket) } : null;
}
