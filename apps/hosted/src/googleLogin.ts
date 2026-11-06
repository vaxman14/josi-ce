// Sign in or sign up with Google, for the Hey Josi account itself. Nothing here
// touches a person's server: this asks Google who someone is and nothing else, so
// it uses only the identity scopes and keeps no token.
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import { googleLogin, googleTicket } from './accounts.js';
import type { Ctx } from './context.js';
import { hmacHex, randomToken, safeEqual } from './crypto.js';
import { hit } from './db.js';
import { HttpError } from './errors.js';
import { AUTH_URL, API, tokenCall } from './google.js';
import { notice } from './pages.js';
import { GOOGLE_NEW_COOKIE, MFA_COOKIE, clientIp, cookieOptions, cookies, startSession } from './web.js';

const LOGIN_COOKIE = '__Host-hj_google';
const STATE_TTL_MS = 10 * 60_000, TICKET_TTL_MS = 15 * 60_000;
const ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const EXPIRED = ['That sign-in has expired', 'Go back and try again.', '/login'] as const;

/** Three pieces, so the connector flow's two-piece state can never be read as one of these. */
export const isLoginState = (state: unknown): boolean => typeof state === 'string' && state.startsWith('login.');

function loginState(ctx: Ctx, nonce: string): string {
  const body = Buffer.from(JSON.stringify({ n: nonce, e: ctx.now() + STATE_TTL_MS })).toString('base64url');
  return `login.${body}.${hmacHex(ctx.oauthKey, `login|${body}`)}`;
}

function stateMatches(ctx: Ctx, state: unknown, nonce: string): boolean {
  const [, body, signature, extra] = String(state ?? '').split('.');
  if (!body || !signature || extra !== undefined || !safeEqual(signature, hmacHex(ctx.oauthKey, `login|${body}`))) return false;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { n: string; e: number };
    return claims.e > ctx.now() && safeEqual(claims.n, nonce);
  } catch { return false; }
}

export function startGoogleLogin(ctx: Ctx, _req: Request, res: Response): void {
  const nonce = randomToken(), verifier = randomToken(48);
  res.cookie(LOGIN_COOKIE, `${nonce}.${verifier}`, { ...cookieOptions, maxAge: STATE_TTL_MS });
  const params = new URLSearchParams({
    client_id: ctx.config.google.clientId, redirect_uri: ctx.config.google.redirectUri, response_type: 'code', scope: `openid ${API}userinfo.email`,
    state: loginState(ctx, nonce), nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    prompt: 'select_account',
  });
  res.set('cache-control', 'no-store').redirect(302, `${AUTH_URL}?${params}`);
}

/** The token came straight from Google over TLS, so its signature needs no second
 * check, but the claims still have to be for us, for this attempt, and verified. */
function verifiedEmail(ctx: Ctx, idToken: unknown, nonce: string): string | null {
  try {
    const claims = JSON.parse(Buffer.from(String(idToken).split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
    if (!ISSUERS.has(String(claims.iss)) || claims.aud !== ctx.config.google.clientId || claims.nonce !== nonce) return null;
    if (!(Number(claims.exp) * 1000 > ctx.now()) || (claims.email_verified !== true && claims.email_verified !== 'true')) return null;
    return typeof claims.email === 'string' && claims.email ? claims.email : null;
  } catch { return null; }
}

export async function finishGoogleLogin(ctx: Ctx, req: Request, res: Response): Promise<void> {
  const [nonce, verifier] = (cookies(req)[LOGIN_COOKIE] ?? '').split('.');
  res.clearCookie(LOGIN_COOKIE, cookieOptions);
  res.set('cache-control', 'no-store');
  if (!nonce || !verifier || !stateMatches(ctx, req.query.state, nonce)) { notice(res, 400, ...EXPIRED); return; }
  const code = req.query.code;
  if (typeof code !== 'string' || !code) { res.redirect(302, '/login'); return; }
  if (!await hit(ctx, `google-ip:${clientIp(ctx, req)}`, 30, 900)) { notice(res, 429, 'Too many tries', 'Wait 15 minutes, then try again.', '/login'); return; }
  let email: string | null = null;
  try {
    const reply = await tokenCall(ctx, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: ctx.config.google.redirectUri });
    email = verifiedEmail(ctx, reply.body.id_token, nonce);
    if (!email) ctx.log('google_login_refused', { status: reply.status });
  } catch { ctx.log('google_login_unavailable', {}); }
  if (!email) { notice(res, 502, 'Google didn\'t confirm that', 'Nothing changed. Try again, or use your email and password.', '/login'); return; }
  try {
    const session = await googleLogin(ctx, email);
    if (!session) { res.cookie(GOOGLE_NEW_COOKIE, googleTicket(ctx, email), { ...cookieOptions, maxAge: TICKET_TTL_MS }); res.redirect(302, '/signup/google'); return; }
    if (session.mfa) { res.cookie(MFA_COOKIE, session.token, { ...cookieOptions, maxAge: 5 * 60_000 }); res.redirect(302, '/login#2fa'); return; }
    startSession(res, session.token);
    res.redirect(302, '/account');
  } catch (error) {
    if (error instanceof HttpError) notice(res, error.status, 'That didn\'t work', error.message, '/login');
    else throw error;
  }
}
