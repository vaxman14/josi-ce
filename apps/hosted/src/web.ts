// The account pages' JSON API. Every change needs a CSRF token as well as the
// cookie. SameSite alone isn't enough here: <name>.heyjosi.com is the same site as
// heyjosi.com, and those addresses run whatever the person's own server sends.
import express, { type NextFunction, type Request, type Response, type Router } from 'express';
import { randomBytes } from 'node:crypto';
import { beginTotp, changePassword, completeLogin, completeReset, createLinkCode, deleteAccount, disableTotp, enableTotp, endSession, login, newRecoveryCodes,
  requestReset, resendVerification, sessionFrom, signUp, twoFactorState, verifyEmail, SESSION_TTL_MS, type Session } from './accounts.js';
import { usageFor } from './ai/allowance.js';
import { openPortal, startCheckout, startTopUp, topUpHistory } from './billing.js';
import type { Ctx } from './context.js';
import { hmacHex, safeEqual } from './crypto.js';
import { audit, iso } from './db.js';
import { listDevices, revokeDevice } from './devices.js';
import { HttpError } from './errors.js';
import { acceptInvite, householdView, inviteMember, removeMember, setMemberCap } from './household.js';
import { PLANS, aiPool, planOf } from './plans.js';

// __Host- means no subdomain can set these, which is the point: see above.
export const SESSION_COOKIE = '__Host-hj_session';
const PRE_COOKIE = '__Host-hj_pre';
const MFA_COOKIE = '__Host-hj_mfa';

interface Authed extends Request { session?: Session | null }

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const piece of (req.get('cookie') ?? '').split(';')) {
    const at = piece.indexOf('=');
    if (at > 0) out[piece.slice(0, at).trim()] = piece.slice(at + 1).trim();
  }
  return out;
}

const cookieOptions = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;

export function clientIp(ctx: Ctx, req: Request): string {
  const header = ctx.config.clientIpHeader ? req.get(ctx.config.clientIpHeader) : undefined;
  return header?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
}

export const loadSession = (ctx: Ctx) => async (req: Authed, _res: Response, next: NextFunction): Promise<void> => {
  req.session = await sessionFrom(ctx, cookies(req)[SESSION_COOKIE]);
  next();
};

function csrfFor(ctx: Ctx, req: Authed, pre?: string): string | null {
  const subject = req.session ? `session:${req.session.id}` : (pre ?? cookies(req)[PRE_COOKIE]);
  return subject ? hmacHex(ctx.csrfKey, subject) : null;
}

const checkCsrf = (ctx: Ctx) => (req: Authed, _res: Response, next: NextFunction): void => {
  if (req.method === 'GET' || req.method === 'HEAD') { next(); return; }
  const expected = csrfFor(ctx, req), supplied = req.get('x-csrf-token') ?? '';
  if (req.get('origin') !== ctx.config.publicOrigin || !expected || !safeEqual(supplied, expected)) throw new HttpError(403, 'This page has gone stale. Reload it and try again.', 'csrf');
  next();
};

const requireSession = (req: Authed, _res: Response, next: NextFunction): void => {
  if (!req.session) throw new HttpError(401, 'Log in first.', 'signed_out');
  next();
};

function startSession(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_TTL_MS });
  res.clearCookie(MFA_COOKIE, cookieOptions);
}

async function accountView(ctx: Ctx, session: Session): Promise<Record<string, unknown>> {
  const { id, email, handle } = session.account;
  const plan = await planOf(ctx, id);
  const [latest] = await ctx.db.query<{ status: string }>('select status from heyjosi.subscriptions where account_id = $1 order by updated_at desc limit 1', [id]);
  const [server] = await ctx.db.query<{ version: string | null; last_sync_at: unknown; ai_token_hash: string | null }>('select version, last_sync_at, ai_token_hash from heyjosi.servers where account_id = $1', [id]);
  return {
    email, handle, address: `${handle}.${ctx.config.domain}`, downloadUrl: 'https://get.heyjosi.com',
    plan: { id: plan.plan, label: PLANS[plan.plan].label, status: plan.status ?? latest?.status ?? null, periodEnd: plan.periodEnd, cancelAtPeriodEnd: plan.cancelAtPeriodEnd,
      paymentProblem: latest?.status === 'past_due' || latest?.status === 'unpaid' },
    plans: Object.entries(PLANS).map(([key, value]) => ({ id: key, label: value.label, monthlyUsd: value.monthlyUsd })),
    server: server ? { linked: true, version: server.version, lastSyncAt: iso(server.last_sync_at), hasAiToken: !!server.ai_token_hash } : { linked: false },
    usage: await usageFor(ctx, id), aiActive: !!await aiPool(ctx, id), household: await householdView(ctx, id), topUps: await topUpHistory(ctx, id),
    devices: await listDevices(ctx, id), twoFactor: await twoFactorState(ctx, id),
  };
}

export function apiRouter(ctx: Ctx): Router {
  const api = express.Router();
  api.use(express.json({ limit: '32kb' }));
  api.use(loadSession(ctx));
  api.use(checkCsrf(ctx));
  const ip = (req: Request) => clientIp(ctx, req);

  api.get('/csrf', (req: Authed, res) => {
    let pre = cookies(req)[PRE_COOKIE];
    if (!pre && !req.session) { pre = randomBytes(24).toString('base64url'); res.cookie(PRE_COOKIE, pre, cookieOptions); }
    res.set('cache-control', 'no-store').json({ token: csrfFor(ctx, req, pre), signedIn: !!req.session });
  });

  api.post('/signup', async (req, res) => {
    await signUp(ctx, { email: req.body?.email, password: req.body?.password, handle: req.body?.handle, ip: ip(req) });
    res.status(202).json({ ok: true });
  });
  api.post('/verify-email', async (req, res) => { await verifyEmail(ctx, req.body?.token); res.json({ ok: true }); });
  api.post('/resend-verification', async (req, res) => { await resendVerification(ctx, { email: req.body?.email, ip: ip(req) }); res.status(202).json({ ok: true }); });

  api.post('/login', async (req, res) => {
    const result = await login(ctx, { email: req.body?.email, password: req.body?.password, ip: ip(req) });
    if (result.mfa) res.cookie(MFA_COOKIE, result.token, { ...cookieOptions, maxAge: 5 * 60_000 });
    else startSession(res, result.token);
    res.json({ ok: true, mfa: result.mfa });
  });
  api.post('/login/2fa', async (req, res) => { startSession(res, await completeLogin(ctx, cookies(req)[MFA_COOKIE], req.body?.code)); res.json({ ok: true }); });
  api.post('/logout', async (req: Authed, res) => {
    if (req.session) await endSession(ctx, req.session.id);
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ ok: true });
  });
  api.post('/forgot', async (req, res) => { await requestReset(ctx, { email: req.body?.email, ip: ip(req) }); res.status(202).json({ ok: true }); });
  api.post('/reset', async (req, res) => { await completeReset(ctx, { token: req.body?.token, password: req.body?.password }); res.json({ ok: true }); });

  // Everything below belongs to a signed-in person.
  api.use(requireSession);
  const session = (req: Authed): Session => req.session!;

  api.get('/account', async (req: Authed, res) => { res.set('cache-control', 'no-store').json(await accountView(ctx, session(req))); });
  api.post('/password', async (req: Authed, res) => { await changePassword(ctx, session(req), { current: req.body?.current, next: req.body?.next }); res.json({ ok: true }); });
  api.post('/2fa/begin', async (req: Authed, res) => { res.set('cache-control', 'no-store').json(await beginTotp(ctx, session(req), req.body?.password)); });
  api.post('/2fa/enable', async (req: Authed, res) => { res.set('cache-control', 'no-store').json({ recoveryCodes: await enableTotp(ctx, session(req), req.body?.code) }); });
  api.post('/2fa/disable', async (req: Authed, res) => { await disableTotp(ctx, session(req), { password: req.body?.password, code: req.body?.code }); res.json({ ok: true }); });
  api.post('/2fa/recovery-codes', async (req: Authed, res) => {
    res.set('cache-control', 'no-store').json({ recoveryCodes: await newRecoveryCodes(ctx, session(req), { password: req.body?.password, code: req.body?.code }) });
  });

  api.post('/link-code', async (req: Authed, res) => { res.set('cache-control', 'no-store').json(await createLinkCode(ctx, session(req).account.id)); });
  api.post('/devices/:id/revoke', async (req: Authed, res) => { res.json(await revokeDevice(ctx, session(req).account.id, String(req.params.id))); });
  api.post('/ai-token/reset', async (req: Authed, res) => {
    // The next sync hands the server a new one.
    await ctx.db.query('update heyjosi.servers set ai_token_hash = null, ai_token_issued_at = null where account_id = $1', [session(req).account.id]);
    await audit(ctx.db, session(req).account.id, 'ai_token.reset');
    res.json({ ok: true });
  });

  api.post('/billing/checkout', async (req: Authed, res) => { res.json({ url: await startCheckout(ctx, session(req).account, req.body?.plan) }); });
  api.post('/billing/portal', async (req: Authed, res) => { res.json({ url: await openPortal(ctx, session(req).account) }); });
  api.post('/billing/topup', async (req: Authed, res) => { res.json({ url: await startTopUp(ctx, session(req).account, req.body?.usd) }); });

  api.post('/household/invite', async (req: Authed, res) => { await inviteMember(ctx, session(req).account.id, req.body?.email); res.status(202).json({ ok: true }); });
  api.post('/household/accept', async (req: Authed, res) => { await acceptInvite(ctx, session(req), req.body?.token); res.json({ ok: true }); });
  api.post('/household/members/:id/cap', async (req: Authed, res) => { await setMemberCap(ctx, session(req).account.id, String(req.params.id), req.body?.capUsd); res.json({ ok: true }); });
  api.post('/household/members/:id/remove', async (req: Authed, res) => { await removeMember(ctx, session(req).account.id, String(req.params.id)); res.json({ ok: true }); });

  api.post('/account/delete', async (req: Authed, res) => {
    await deleteAccount(ctx, session(req), { password: req.body?.password, code: req.body?.code });
    res.clearCookie(SESSION_COOKIE, cookieOptions);
    res.json({ ok: true });
  });
  return api;
}


