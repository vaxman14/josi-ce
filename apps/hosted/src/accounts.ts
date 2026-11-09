// Hey Josi accounts. An account pays for things and owns a name. It never holds a
// way in to the person's Josi server: there's deliberately nothing here that a
// login could turn into a session over there.
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { hashPassword, verifyPassword } from '@josi-ce/auth';
import type { Db } from '@josi-ce/core';
import { PAIRING_TTL_SECONDS, codeHash, displayCode, newPairingCode } from '@josi-ce/tunnel';
import type { Ctx } from './context.js';
import { hmacHex, randomToken, safeEqual, seal, sha256, unseal } from './crypto.js';
import { audit, clearHits, hit, inTx, num } from './db.js';
import { HttpError } from './errors.js';
import { queueRevocation, flushRevocations } from './grants.js';
import { validHandle } from './handle.js';

export const SESSION_TTL_MS = 30 * 86_400_000;
const PENDING_TTL_MS = 5 * 60_000;
const VERIFY_TTL_MS = 48 * 3_600_000;
const RESET_TTL_MS = 3_600_000;
const MIN_PASSWORD = 12, MAX_PASSWORD = 1024;
const RECOVERY_CODES = 10;
const MAIL_WAIT_MS = 12_000;
const GOOGLE_TICKET_TTL_MS = 15 * 60_000;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface Account { has_password: boolean; id: string; email: string; handle: string; status: string; email_verified_at: unknown; password_hash: string; stripe_customer_id: string | null; created_at: unknown }

export const normalizeEmail = (email: unknown): string => String(email ?? '').trim().toLowerCase();
const validEmail = (email: string): boolean => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

function checkPassword(password: unknown): string {
  const value = String(password ?? '');
  if (value.length < MIN_PASSWORD) throw new HttpError(400, `Use at least ${MIN_PASSWORD} characters for your password.`);
  if (value.length > MAX_PASSWORD) throw new HttpError(400, 'That password is too long.');
  return value;
}

const accountRow = async (db: Db, id: string): Promise<Account | null> => (await db.query<Account>('select * from heyjosi.accounts where id = $1', [id]))[0] ?? null;

export async function mail(ctx: Ctx, to: string, subject: string, text: string): Promise<void> {
  // A mail outage shouldn't undo a signup: the person can ask for another link.
  // A stuck mail server shouldn't hold the person's page open either.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('mail timed out')), MAIL_WAIT_MS); });
  try { await Promise.race([ctx.mailer.send({ to, subject, text }), late]); } catch { ctx.log('mail_failed', { subject }); } finally { clearTimeout(timer); }
}

async function emailToken(ctx: Ctx, db: Db, accountId: string, kind: 'verify' | 'reset', ttlMs: number): Promise<string> {
  await db.query('delete from heyjosi.email_tokens where account_id = $1 and kind = $2', [accountId, kind]);
  const token = randomToken();
  await db.query('insert into heyjosi.email_tokens (account_id, kind, token_hash, expires_at) values ($1, $2, $3, $4::timestamptz)', [accountId, kind, sha256(token), ctx.at(ttlMs)]);
  return token;
}

async function welcome(ctx: Ctx, email: string, handle: string): Promise<void> {
  await mail(ctx, email, 'Welcome to Hey Josi', `Your account is ready, and ${handle}.${ctx.config.domain} is yours.

Here's what to do next:

1. Download Josi and install it on your computer: https://get.heyjosi.com
2. Make a link code on your account page and enter it on your Josi server: ${ctx.config.publicOrigin}/account
3. Pair your phone and other devices from your Josi server.

While you're there, add an authenticator app under Security.

Everything between your devices and your server is encrypted. We can't read it.

Questions? Write to support@heyjosi.com.`);
}

async function sendVerification(ctx: Ctx, accountId: string, email: string): Promise<void> {
  const token = await emailToken(ctx, ctx.db, accountId, 'verify', VERIFY_TTL_MS);
  // The token rides in the fragment, so it stays out of request logs and referrers.
  await mail(ctx, email, 'Confirm your Hey Josi email', `Confirm your email to finish setting up Hey Josi:\n\n${ctx.config.publicOrigin}/verify#token=${token}\n\nThis link works for 48 hours. If this wasn't you, ignore this message.`);
}

/** The answer is the same whether or not the email already has an account, so
 * this form can't be used to find out who has one. */
export async function signUp(ctx: Ctx, args: { email: unknown; password: unknown; handle: unknown; ip: string }): Promise<void> {
  const email = normalizeEmail(args.email), handle = String(args.handle ?? '').trim().toLowerCase();
  if (!validEmail(email)) throw new HttpError(400, 'Enter a valid email address.');
  const password = checkPassword(args.password);
  if (!validHandle(handle)) throw new HttpError(400, 'Pick another name: 3 to 32 letters, numbers or single dashes, starting with a letter.');
  if (!await hit(ctx, `signup:${args.ip}`, 10, 3600)) throw new HttpError(429, 'Too many signups from this network. Try again in an hour.');
  const hash = await hashPassword(password);
  const [taken] = await ctx.db.query(
    `select 1 from heyjosi.accounts where handle = $1 union all select 1 from heyjosi.relay_revocations where name = $1`, [handle]);
  if (taken) throw new HttpError(409, 'That name is taken. Try another.');
  const [existing] = await ctx.db.query('select id from heyjosi.accounts where email = $1', [email]);
  if (existing) {
    await mail(ctx, email, 'You already have a Hey Josi account', `Someone tried to sign up with this email, but it already has an account. To get back in, reset your password at ${ctx.config.publicOrigin}/forgot. If this wasn't you, you can ignore this message.`);
    return;
  }
  const [row] = await ctx.db.query<{ id: string }>(
    'insert into heyjosi.accounts (email, password_hash, handle) values ($1, $2, $3) on conflict do nothing returning id', [email, hash, handle]);
  if (!row) throw new HttpError(409, 'That name is taken. Try another.');
  await audit(ctx.db, row.id, 'account.created');
  await sendVerification(ctx, row.id, email);
}

/** Proves to the next page that Google vouched for this email just now. */
export function googleTicket(ctx: Ctx, email: string): string {
  const body = Buffer.from(JSON.stringify({ m: normalizeEmail(email), e: ctx.now() + GOOGLE_TICKET_TTL_MS })).toString('base64url');
  return `${body}.${hmacHex(ctx.oauthKey, `ticket|${body}`)}`;
}

function ticketEmail(ctx: Ctx, ticket: unknown): string | null {
  const [body, signature, extra] = String(ticket ?? '').split('.');
  if (!body || !signature || extra !== undefined || !safeEqual(signature, hmacHex(ctx.oauthKey, `ticket|${body}`))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { m: string; e: number };
    return claims.e > ctx.now() ? claims.m : null;
  } catch { return null; }
}

/** Google has confirmed this email. Null means it has no account yet.
 *
 * An unconfirmed account with this email may have been made by someone else, to
 * sit waiting for the real owner. Its password is replaced, so whoever set it
 * can't get in once Google has confirmed who the email belongs to. */
export async function googleLogin(ctx: Ctx, email: string): Promise<{ token: string; mfa: boolean } | null> {
  const address = normalizeEmail(email);
  const [row] = await ctx.db.query<Account>('select * from heyjosi.accounts where email = $1', [address]);
  if (!row) return null;
  if (row.status !== 'active') throw new HttpError(403, 'This account is suspended. Write to support@heyjosi.com.');
  if (!row.email_verified_at) {
    const hash = await hashPassword(randomToken());
    await inTx(ctx.db, async tx => {
      await tx.query('update heyjosi.accounts set email_verified_at = $2::timestamptz, password_hash = $3, has_password = false where id = $1', [row.id, ctx.at(), hash]);
      await tx.query('delete from heyjosi.sessions where account_id = $1', [row.id]);
      await tx.query('delete from heyjosi.email_tokens where account_id = $1', [row.id]);
    });
    await welcome(ctx, address, row.handle);
  }
  const [totp] = await ctx.db.query('select 1 from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null', [row.id]);
  await audit(ctx.db, row.id, totp ? 'login.google_ok' : 'login.google');
  return { token: await createSession(ctx, row.id, ctx.db, !!totp), mfa: !!totp };
}

/** The account has no usable password until its owner sets one with a reset link. */
export async function signUpWithGoogle(ctx: Ctx, args: { ticket: unknown; handle: unknown; ip: string }): Promise<string> {
  const email = ticketEmail(ctx, args.ticket);
  if (!email) throw new HttpError(400, 'That sign-in has expired. Go back and continue with Google again.');
  const handle = String(args.handle ?? '').trim().toLowerCase();
  if (!validHandle(handle)) throw new HttpError(400, 'Pick another name: 3 to 32 letters, numbers or single dashes, starting with a letter.');
  if (!await hit(ctx, `signup:${args.ip}`, 10, 3600)) throw new HttpError(429, 'Too many signups from this network. Try again in an hour.');
  const [taken] = await ctx.db.query(
    `select 1 from heyjosi.accounts where handle = $1 union all select 1 from heyjosi.relay_revocations where name = $1`, [handle]);
  if (taken) throw new HttpError(409, 'That name is taken. Try another.');
  const [row] = await ctx.db.query<{ id: string }>(
    'insert into heyjosi.accounts (email, email_verified_at, password_hash, handle, has_password) values ($1, $2::timestamptz, $3, $4, false) on conflict do nothing returning id',
    [email, ctx.at(), await hashPassword(randomToken()), handle]);
  if (!row) throw new HttpError(409, 'That email already has an account, or the name was just taken. Try logging in.');
  await audit(ctx.db, row.id, 'account.created_google');
  await welcome(ctx, email, handle);
  return createSession(ctx, row.id);
}

export async function resendVerification(ctx: Ctx, args: { email: unknown; ip: string }): Promise<void> {
  const email = normalizeEmail(args.email);
  if (!await hit(ctx, `mail:${email}`, 5, 3600) || !await hit(ctx, `mail-ip:${args.ip}`, 20, 3600)) return;
  const [row] = await ctx.db.query<Account>('select * from heyjosi.accounts where email = $1 and email_verified_at is null', [email]);
  if (row) await sendVerification(ctx, row.id, email);
}

export async function useToken(ctx: Ctx, db: Db, token: unknown, kind: string): Promise<{ account_id: string | null; email: string | null; household_id: string | null } | null> {
  const [row] = await db.query<{ account_id: string | null; email: string | null; household_id: string | null }>(
    `update heyjosi.email_tokens set used_at = $3::timestamptz
      where token_hash = $1 and kind = $2 and used_at is null and expires_at > $3::timestamptz returning account_id, email, household_id`,
    [sha256(String(token ?? '')), kind, ctx.at()]);
  return row ?? null;
}

export async function verifyEmail(ctx: Ctx, token: unknown): Promise<void> {
  const row = await useToken(ctx, ctx.db, token, 'verify');
  if (!row?.account_id) throw new HttpError(400, 'That link is wrong or has expired. Log in to get a new one.');
  await ctx.db.query('update heyjosi.accounts set email_verified_at = $2::timestamptz where id = $1', [row.account_id, ctx.at()]);
  await audit(ctx.db, row.account_id, 'account.verified');
  const account = await accountRow(ctx.db, row.account_id);
  if (account) await welcome(ctx, account.email, account.handle);
}

export async function createSession(ctx: Ctx, accountId: string, db: Db = ctx.db, pending = false): Promise<string> {
  const token = randomToken();
  await db.query('insert into heyjosi.sessions (account_id, token_hash, mfa_pending, expires_at) values ($1, $2, $3, $4::timestamptz)',
    [accountId, sha256(token), pending, ctx.at(pending ? PENDING_TTL_MS : SESSION_TTL_MS)]);
  return token;
}

export interface Session { id: string; account: Account }

export async function sessionFrom(ctx: Ctx, token: string | undefined, pending = false): Promise<Session | null> {
  if (!token) return null;
  const [row] = await ctx.db.query<Account & { session_id: string }>(
    `select a.*, s.id as session_id from heyjosi.sessions s join heyjosi.accounts a on a.id = s.account_id
      where s.token_hash = $1 and s.mfa_pending = $2 and s.expires_at > $3::timestamptz and a.status = 'active'`, [sha256(token), pending, ctx.at()]);
  return row ? { id: row.session_id, account: row } : null;
}

export const endSession = async (ctx: Ctx, sessionId: string): Promise<void> => { await ctx.db.query('delete from heyjosi.sessions where id = $1', [sessionId]); };

export async function login(ctx: Ctx, args: { email: unknown; password: unknown; ip: string }): Promise<{ token: string; mfa: boolean }> {
  const email = normalizeEmail(args.email), password = String(args.password ?? '');
  const byEmail = await hit(ctx, `login:${email}`, 8, 900), byIp = await hit(ctx, `login-ip:${args.ip}`, 25, 900);
  if (!byEmail || !byIp) throw new HttpError(429, 'Too many tries. Wait 15 minutes, or reset your password.');
  const [row] = await ctx.db.query<Account>('select * from heyjosi.accounts where email = $1', [email]);
  // Hashing even with no such account, so timing doesn't say which emails exist.
  const ok = password.length <= MAX_PASSWORD && await verifyPassword(row?.password_hash ?? null, password);
  if (!ok || !row) throw new HttpError(401, 'That email or password is wrong.');
  if (row.status !== 'active') throw new HttpError(403, 'This account is suspended. Write to support@heyjosi.com.');
  if (!row.email_verified_at) throw new HttpError(403, 'Confirm your email first. We can send the link again.', 'unverified');
  await clearHits(ctx, `login:${email}`);
  const [totp] = await ctx.db.query('select 1 from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null', [row.id]);
  await audit(ctx.db, row.id, totp ? 'login.password_ok' : 'login.ok');
  return { token: await createSession(ctx, row.id, ctx.db, !!totp), mfa: !!totp };
}

/** Checks a TOTP code or spends a recovery code. Both refuse a second use. */
export async function checkFactor(ctx: Ctx, accountId: string, supplied: unknown): Promise<boolean> {
  if (!await hit(ctx, `factor:${accountId}`, 8, 900)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  const code = String(supplied ?? '').replace(/[\s-]/g, '').toUpperCase().slice(0, 64);
  if (/^\d{6}$/.test(code)) {
    const [row] = await ctx.db.query<{ secret_sealed: string }>('select secret_sealed from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null', [accountId]);
    if (!row) return false;
    const result = await verifyTotp(ctx, accountId, row.secret_sealed, code);
    if (result === null) return false;
    const used = await ctx.db.query(
      'update heyjosi.totp_secrets set last_step = $2 where account_id = $1 and (last_step is null or last_step < $2) returning account_id', [accountId, result]);
    return used.length === 1;
  }
  const used = await ctx.db.query(
    `update heyjosi.recovery_codes set used_at = $3::timestamptz where account_id = $1 and code_hash = $2 and used_at is null returning id`, [accountId, sha256(code), ctx.at()]);
  if (used.length) await audit(ctx.db, accountId, 'recovery_code.used');
  return used.length === 1;
}

async function verifyTotp(ctx: Ctx, accountId: string, sealed: string, code: string): Promise<number | null> {
  const secret = unseal(ctx.config.accountDataKey, sealed, `totp:${accountId}`);
  const epoch = Math.floor(ctx.now() / 1000);
  const result = await verify({ secret, token: code, epoch, epochTolerance: 30 });
  return result.valid ? Math.floor(epoch / 30) + result.delta : null;
}

/** Trades a password-checked pending session for a real one. */
/** One authenticator for the whole platform: a linked server asks for this
 * account's secret to use at its own sign-in. A live code proves the person asking
 * holds the authenticator, so a server alone can't take it. A second factor is
 * all this hands over: it's still no way in without that server's own password. */
export async function shareTotp(ctx: Ctx, accountId: string, supplied: unknown): Promise<Record<string, unknown>> {
  const code = String(supplied ?? '').replace(/\s/g, '');
  const refused = { ok: false, error: 'bad_code', message: 'That code didn\'t match your Hey Josi authenticator.' };
  if (!/^\d{6}$/.test(code)) return refused;
  const [row] = await ctx.db.query<{ secret_sealed: string }>('select secret_sealed from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null', [accountId]);
  if (!row) return { ok: false, error: 'no_totp', message: 'Turn on the authenticator under Security on your Hey Josi account first.' };
  try { if (!await checkFactor(ctx, accountId, code)) return refused; }
  catch (error) { if (error instanceof HttpError) return { ok: false, error: 'limited', message: error.message }; throw error; }
  await audit(ctx.db, accountId, 'totp.shared');
  return { ok: true, secret: unseal(ctx.config.accountDataKey, row.secret_sealed, `totp:${accountId}`) };
}

export async function completeLogin(ctx: Ctx, pendingToken: string | undefined, code: unknown): Promise<string> {
  const pending = await sessionFrom(ctx, pendingToken, true);
  if (!pending) throw new HttpError(401, 'That login has timed out. Start again.');
  if (!await checkFactor(ctx, pending.account.id, code)) throw new HttpError(401, 'That code is wrong.');
  await endSession(ctx, pending.id);
  await audit(ctx.db, pending.account.id, 'login.ok');
  return createSession(ctx, pending.account.id);
}

export async function requestReset(ctx: Ctx, args: { email: unknown; ip: string }): Promise<void> {
  const email = normalizeEmail(args.email);
  if (!await hit(ctx, `mail:${email}`, 5, 3600) || !await hit(ctx, `mail-ip:${args.ip}`, 20, 3600)) return;
  const [row] = await ctx.db.query<Account>('select * from heyjosi.accounts where email = $1', [email]);
  if (!row) return;
  const token = await emailToken(ctx, ctx.db, row.id, 'reset', RESET_TTL_MS);
  await mail(ctx, email, 'Reset your Hey Josi password', `Use this link to choose a new password:\n\n${ctx.config.publicOrigin}/reset#token=${token}\n\nIt works for one hour. If this wasn't you, ignore this message and nothing changes.`);
}

/** Two-step sign-in still applies afterwards: a stolen inbox alone isn't enough. */
export async function completeReset(ctx: Ctx, args: { token: unknown; password: unknown }): Promise<void> {
  const password = checkPassword(args.password);
  const hash = await hashPassword(password);
  await inTx(ctx.db, async tx => {
    const row = await useToken(ctx, tx, args.token, 'reset');
    if (!row?.account_id) throw new HttpError(400, 'That link is wrong or has expired. Ask for a new one.');
    // Reaching this link proves the inbox, so a reset also confirms the email.
    await tx.query('update heyjosi.accounts set password_hash = $2, has_password = true, email_verified_at = coalesce(email_verified_at, $3::timestamptz) where id = $1', [row.account_id, hash, ctx.at()]);
    await tx.query('delete from heyjosi.sessions where account_id = $1', [row.account_id]);
    await audit(tx, row.account_id, 'password.reset');
  });
}

async function requirePassword(account: Account, password: unknown): Promise<void> {
  if (!account.has_password) throw new HttpError(400, 'Create a password first.', 'no_password');
  if (!await verifyPassword(account.password_hash, String(password ?? '').slice(0, MAX_PASSWORD))) throw new HttpError(401, 'That password is wrong.');
}

/** For an account made with Google, which has no password to prove. */
export async function createPassword(ctx: Ctx, session: Session, password: unknown): Promise<void> {
  if (!await hit(ctx, `password:${session.account.id}`, 8, 900)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  if (session.account.has_password) throw new HttpError(409, 'This account already has a password.');
  const hash = await hashPassword(checkPassword(password));
  await ctx.db.query('update heyjosi.accounts set password_hash = $2, has_password = true where id = $1 and has_password = false', [session.account.id, hash]);
  await audit(ctx.db, session.account.id, 'password.created');
}

export async function changePassword(ctx: Ctx, session: Session, args: { current: unknown; next: unknown }): Promise<void> {
  if (!await hit(ctx, `password:${session.account.id}`, 8, 900)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  await requirePassword(session.account, args.current);
  const hash = await hashPassword(checkPassword(args.next));
  await ctx.db.query('update heyjosi.accounts set password_hash = $2 where id = $1', [session.account.id, hash]);
  await ctx.db.query('delete from heyjosi.sessions where account_id = $1 and id <> $2', [session.account.id, session.id]);
  await audit(ctx.db, session.account.id, 'password.changed');
}

export async function beginTotp(ctx: Ctx, session: Session, password: unknown): Promise<{ secret: string; uri: string; qr: string }> {
  if (!await hit(ctx, `password:${session.account.id}`, 8, 900)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  await requirePassword(session.account, password);
  const id = session.account.id;
  const [enabled] = await ctx.db.query('select 1 from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null', [id]);
  if (enabled) throw new HttpError(409, 'Two-step sign-in is already on.');
  const secret = generateSecret();
  await ctx.db.query(
    `insert into heyjosi.totp_secrets (account_id, secret_sealed) values ($1, $2)
     on conflict (account_id) do update set secret_sealed = excluded.secret_sealed, last_step = null`, [id, seal(ctx.config.accountDataKey, secret, `totp:${id}`)]);
  const uri = generateURI({ issuer: 'Hey Josi', label: session.account.email, secret });
  return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
}

function recoveryCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => CROCKFORD[byte & 31]).join('').replace(/(.{4})(?=.)/g, '$1-');
}

async function replaceRecoveryCodes(ctx: Ctx, db: Db, accountId: string): Promise<string[]> {
  await db.query('delete from heyjosi.recovery_codes where account_id = $1', [accountId]);
  const codes = Array.from({ length: RECOVERY_CODES }, recoveryCode);
  for (const code of codes) await db.query('insert into heyjosi.recovery_codes (account_id, code_hash) values ($1, $2)', [accountId, sha256(code.replaceAll('-', ''))]);
  return codes;
}

export async function enableTotp(ctx: Ctx, session: Session, code: unknown): Promise<string[]> {
  const id = session.account.id;
  if (!await hit(ctx, `factor:${id}`, 8, 900)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  const [row] = await ctx.db.query<{ secret_sealed: string }>('select secret_sealed from heyjosi.totp_secrets where account_id = $1 and enabled_at is null', [id]);
  if (!row) throw new HttpError(409, 'Start setting up two-step sign-in first.');
  const step = /^\d{6}$/.test(String(code ?? '').trim()) ? await verifyTotp(ctx, id, row.secret_sealed, String(code).trim()) : null;
  if (step === null) throw new HttpError(401, 'That code is wrong. Check the time on your phone and try again.');
  return inTx(ctx.db, async tx => {
    await tx.query('update heyjosi.totp_secrets set enabled_at = $2::timestamptz, last_step = $3 where account_id = $1', [id, ctx.at(), step]);
    await tx.query('delete from heyjosi.sessions where account_id = $1 and id <> $2', [id, session.id]);
    await audit(tx, id, 'totp.enabled');
    return replaceRecoveryCodes(ctx, tx, id);
  });
}

async function requireBoth(ctx: Ctx, session: Session, args: { password: unknown; code: unknown }): Promise<void> {
  if (!await hit(ctx, `password:${session.account.id}`, 8, 900)) throw new HttpError(429, 'Too many tries. Wait 15 minutes.');
  await requirePassword(session.account, args.password);
  const [totp] = await ctx.db.query('select 1 from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null', [session.account.id]);
  if (totp && !await checkFactor(ctx, session.account.id, args.code)) throw new HttpError(401, 'That code is wrong.');
}

export async function disableTotp(ctx: Ctx, session: Session, args: { password: unknown; code: unknown }): Promise<void> {
  await requireBoth(ctx, session, args);
  await inTx(ctx.db, async tx => {
    await tx.query('delete from heyjosi.totp_secrets where account_id = $1', [session.account.id]);
    await tx.query('delete from heyjosi.recovery_codes where account_id = $1', [session.account.id]);
    await audit(tx, session.account.id, 'totp.disabled');
  });
}

export async function newRecoveryCodes(ctx: Ctx, session: Session, args: { password: unknown; code: unknown }): Promise<string[]> {
  await requireBoth(ctx, session, args);
  const [totp] = await ctx.db.query('select 1 from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null', [session.account.id]);
  if (!totp) throw new HttpError(409, 'Turn on two-step sign-in first.');
  return inTx(ctx.db, tx => replaceRecoveryCodes(ctx, tx, session.account.id));
}

export async function twoFactorState(ctx: Ctx, accountId: string): Promise<{ enabled: boolean; recoveryLeft: number }> {
  const [row] = await ctx.db.query<{ enabled: boolean; left: unknown }>(
    `select exists (select 1 from heyjosi.totp_secrets where account_id = $1 and enabled_at is not null) as enabled,
            (select count(*) from heyjosi.recovery_codes where account_id = $1 and used_at is null) as left`, [accountId]);
  return { enabled: !!row?.enabled, recoveryLeft: num(row?.left) };
}

/** A code for linking a server to this account, and nothing else. It can't open
 * a session on that server or pair a device: only the server makes those codes. */
export async function createLinkCode(ctx: Ctx, accountId: string): Promise<{ code: string; expiresAt: string }> {
  if (!await hit(ctx, `link-code:${accountId}`, 20, 3600)) throw new HttpError(429, 'Too many codes. Try again in an hour.');
  const code = newPairingCode(), expires = ctx.at(PAIRING_TTL_SECONDS * 1000);
  await inTx(ctx.db, async tx => {
    await tx.query('delete from heyjosi.link_codes where account_id = $1 and used_at is null', [accountId]);
    await tx.query('insert into heyjosi.link_codes (account_id, code_hash, expires_at) values ($1, $2, $3::timestamptz)', [accountId, codeHash(code), expires]);
    await audit(tx, accountId, 'link_code.created');
  });
  return { code: displayCode(code), expiresAt: expires };
}

export async function deleteAccount(ctx: Ctx, session: Session, args: { password: unknown; code: unknown }): Promise<void> {
  await requireBoth(ctx, session, args);
  const { id, handle, stripe_customer_id: customer } = session.account;
  // Billing goes first. If Stripe can't be reached, the person must not be left
  // with no account and a card that still gets charged. Deleting the customer
  // cancels its subscriptions at once.
  if (customer) {
    await ctx.stripe.delete(`/customers/${encodeURIComponent(customer)}`).catch((error: unknown) => {
      // Already gone at Stripe is what we wanted anyway.
      if ((error as HttpError).code !== 'stripe_404') throw error;
    });
  }
  await inTx(ctx.db, async tx => {
    const [server] = await tx.query('select 1 from heyjosi.servers where account_id = $1', [id]);
    if (server) await queueRevocation(ctx, tx, handle);
    await tx.query('delete from heyjosi.accounts where id = $1', [id]);
    await audit(tx, null, 'account.deleted');
  });
  await flushRevocations(ctx);
}

/** No page calls this: support does, from a shell, for abuse. */
export async function suspendAccount(ctx: Ctx, accountId: string): Promise<void> {
  const account = await accountRow(ctx.db, accountId);
  if (!account) throw new HttpError(404, 'No such account.');
  await inTx(ctx.db, async tx => {
    await tx.query(`update heyjosi.accounts set status = 'suspended' where id = $1`, [accountId]);
    await tx.query('delete from heyjosi.sessions where account_id = $1', [accountId]);
    const [server] = await tx.query('select 1 from heyjosi.servers where account_id = $1', [accountId]);
    if (server) await queueRevocation(ctx, tx, account.handle);
    await audit(tx, accountId, 'account.suspended');
  });
  await flushRevocations(ctx);
}

export async function unsuspendAccount(ctx: Ctx, accountId: string): Promise<void> {
  const account = await accountRow(ctx.db, accountId);
  if (!account) throw new HttpError(404, 'No such account.');
  await inTx(ctx.db, async tx => {
    await tx.query(`update heyjosi.accounts set status = 'active' where id = $1`, [accountId]);
    // A revocation still waiting would otherwise land after this and undo it.
    await tx.query('delete from heyjosi.relay_revocations where name = $1', [account.handle]);
    await audit(tx, accountId, 'account.unsuspended');
  });
}

