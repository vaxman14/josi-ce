// Six-digit sign-in codes by email.
//
// Everything here treats an address with no account exactly like one with an
// account: the row is written, the limits count it, the answer is the same. The
// only difference is that no code exists for it, so nothing can match.
import { createHash, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Db } from '@josi-ce/core';

export const EMAIL_CODE_TTL_SECONDS = 10 * 60;
export const EMAIL_CODE_RESEND_SECONDS = 60;
export const MAX_CODES_PER_EMAIL_PER_HOUR = 5;
export const MAX_CODES_PER_IP_PER_HOUR = 20;
export const MAX_ATTEMPTS_PER_CODE = 5;

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const emailHash = (email: string) => digest(email.trim().toLowerCase());
const codeHash = (id: string, code: string) => digest(`${id}:${code}`);

export type EmailCodeRequest =
  | { outcome: 'limited' }
  | { outcome: 'quiet' }
  | { outcome: 'issued'; code: string | null; user: { id: string; email: string } | null };

/** Issues a code, or says why not. `quiet` is a resend inside the cooldown: the
 * previous code still stands, and the caller answers as if it sent one. */
export async function requestEmailCode(db: Db, args: { email: string; ip: string | null }): Promise<EmailCodeRequest> {
  if (!db.transaction) throw new Error('email codes require transaction support');
  const email = args.email.trim().toLowerCase(), hash = emailHash(email);
  return db.transaction(async tx => {
    // One at a time, so a burst of parallel requests cannot all read a count of
    // zero and go past the limits together. Sign-ins are rare enough to queue.
    await tx.query(`select pg_advisory_xact_lock(hashtext('auth_email_codes'))`);
    await tx.query(`delete from auth_email_codes where created_at < now() - interval '1 day'`);
    const [counts] = await tx.query<{ by_email: number; by_ip: number; latest: number }>(
      `select count(*) filter (where email_hash = $1)::int by_email,
              count(*) filter (where ip is not distinct from $2 and $2 is not null)::int by_ip,
              count(*) filter (where email_hash = $1 and created_at > now() - make_interval(secs => $3))::int latest
       from auth_email_codes where created_at > now() - interval '1 hour'`,
      [hash, args.ip, EMAIL_CODE_RESEND_SECONDS],
    );
    if ((counts?.by_email ?? 0) >= MAX_CODES_PER_EMAIL_PER_HOUR || (counts?.by_ip ?? 0) >= MAX_CODES_PER_IP_PER_HOUR) return { outcome: 'limited' };
    if ((counts?.latest ?? 0) > 0) return { outcome: 'quiet' };

    // Compared with the exact string that was hashed. If Postgres folded case
    // here instead, an address that lowers differently in each would reach a
    // real account under a hash of its own, with limits of its own.
    const [user] = await tx.query<{ id: string; email: string }>(
      `select id, email from users where status = 'active' and lower(email) = $1 limit 1`, [email],
    );
    const id = randomUUID();
    const code = user ? String(randomInt(0, 1_000_000)).padStart(6, '0') : null;
    await tx.query(`update auth_email_codes set used_at = now() where email_hash = $1 and used_at is null`, [hash]);
    await tx.query(
      `insert into auth_email_codes (id, email_hash, user_id, code_hash, ip, expires_at) values ($1, $2, $3, $4, $5, now() + make_interval(secs => $6))`,
      [id, hash, user?.id ?? null, code ? codeHash(id, code) : null, args.ip, EMAIL_CODE_TTL_SECONDS],
    );
    return { outcome: 'issued', code, user: user ?? null };
  });
}

/** Spends a guess. Returns the person only for the right code, once. */
export async function verifyEmailCode(db: Db, args: { email: string; code: string }): Promise<string | null> {
  if (!/^\d{6}$/.test(args.code)) return null;
  const [row] = await db.query<{ id: string; code_hash: string | null }>(
    `select id, code_hash from auth_email_codes
     where email_hash = $1 and used_at is null and expires_at > now() and attempts < $2
     order by created_at desc limit 1`,
    [emailHash(args.email), MAX_ATTEMPTS_PER_CODE],
  );
  if (!row) return null;
  // Counted before looking for a code, so a wrong guess costs the same whether
  // or not the address has an account.
  const counted = await db.query(`update auth_email_codes set attempts = attempts + 1 where id = $1 and used_at is null and attempts < $2 returning id`, [row.id, MAX_ATTEMPTS_PER_CODE]);
  if (!counted.length || !row.code_hash) return null;
  const supplied = Buffer.from(codeHash(row.id, args.code)), stored = Buffer.from(row.code_hash);
  if (supplied.length !== stored.length || !timingSafeEqual(supplied, stored)) return null;
  const [claimed] = await db.query<{ user_id: string | null }>(`update auth_email_codes set used_at = now() where id = $1 and used_at is null returning user_id`, [row.id]);
  return claimed?.user_id ?? null;
}
