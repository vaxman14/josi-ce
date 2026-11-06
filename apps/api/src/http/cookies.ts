// Cookies and CSRF.
//
// The session cookie is httpOnly so injected JavaScript cannot read it. That
// protection is exactly what makes CSRF possible — the browser attaches the
// cookie to a cross-site form post whether the user meant it or not — so a
// second, deliberately readable token is required on every state-changing
// request. Double-submit: the value must appear in both the cookie and a
// header, and an attacker on another origin can set neither.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { SESSION_COOKIE } from '@josi-ce/auth';

export const CSRF_COOKIE = 'josi_csrf';
export const CSRF_HEADER = 'x-josi-csrf';
export const MFA_CHALLENGE_COOKIE = 'josi_mfa_challenge';
export const GOOGLE_STATE_COOKIE = 'josi_google_state';

/** Minimal cookie parse. Two cookies, no signing (the session token is already
 * unguessable and only its hash is stored), no extra dependency. */
export function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

export function readSessionToken(req: Request): string | undefined {
  if (isNativeClient(req)) {
    const authorization = req.header('authorization');
    const match = authorization?.match(/^Bearer\s+([^\s]+)$/i);
    return match?.[1];
  }
  return readCookie(req, SESSION_COOKIE);
}

/** Native apps use an explicit bearer session, so no browser can attach the
 * credential ambiently and CSRF does not apply. Requiring both the client
 * marker and the absence of Origin keeps this seam unavailable to browser
 * JavaScript, including same-device WebViews. */
export function isNativeClient(req: Request): boolean {
  return req.header('x-josi-client') === 'native' && !req.header('origin');
}

/** A bare address, or null. Dual-stack listeners report `::ffff:1.2.3.4`, which
 * would count apart from `1.2.3.4`, and auth_mfa_challenges.ip is `inet`, so
 * anything else in the header would fail the sign-in. */
function plainIp(value: string | undefined): string | null {
  const ip = (value ?? '').trim().replace(/%.*$/, '').replace(/^::ffff:(?=\d+\.)/i, '');
  return isIP(ip) ? ip : null;
}

const ipFamily = (ip: string) => (isIP(ip) === 6 ? 'ipv6' : 'ipv4');

/** The peers allowed to say who the client is. Loopback always is: the native
 * Caddy and the device tunnel both reach the API over it, and both write the
 * header themselves. `list` is JOSI_TRUSTED_PROXIES, addresses or CIDR ranges
 * separated by commas. A typo throws at startup, because the quiet result would
 * be every visitor sharing one rate-limit bucket. */
export function trustedProxyList(list = ''): BlockList {
  const trusted = new BlockList();
  trusted.addSubnet('127.0.0.0', 8, 'ipv4');
  trusted.addAddress('::1', 'ipv6');
  for (const entry of list.split(',').map(part => part.trim()).filter(Boolean)) {
    const [address, prefix, extra] = entry.split('/');
    const family = isIP(address);
    const bits = prefix === undefined ? null : Number(prefix);
    if (!family || extra !== undefined || (bits !== null && (!/^\d+$/.test(prefix) || bits > (family === 6 ? 128 : 32)))) {
      throw new Error(`JOSI_TRUSTED_PROXIES: "${entry}" is not an IP address or CIDR range`);
    }
    if (bits === null) trusted.addAddress(address, ipFamily(address));
    else trusted.addSubnet(address, bits, ipFamily(address));
  }
  return trusted;
}

const LOOPBACK_ONLY = trustedProxyList();
let warnedUntrustedForward = false;

/** The address rate limits and the audit log should use.
 *
 * Anyone can send X-Forwarded-For, so it counts only when the connection itself
 * came from a trusted proxy. Even then it is read from the right: each proxy
 * appends the address it saw, so the first entry nobody trusted is the client,
 * and whatever sits left of that is the client's own writing. */
export function clientIp(req: Request): string | null {
  const peer = plainIp(req.socket.remoteAddress);
  if (!peer) return null;
  const trusted: BlockList = req.app.locals.trustedProxies ?? LOOPBACK_ONLY;
  const forwarded = req.headers['x-forwarded-for'];
  if (!trusted.check(peer, ipFamily(peer))) {
    if (forwarded && !warnedUntrustedForward) {
      warnedUntrustedForward = true;
      console.warn(`josi-ce: ignoring X-Forwarded-For from ${peer}. If that is your reverse proxy, add it to JOSI_TRUSTED_PROXIES, or every visitor shares its rate limits.`);
    }
    return peer;
  }
  let client = peer;
  for (const hop of (typeof forwarded === 'string' ? forwarded : '').split(',').reverse()) {
    const ip = plainIp(hop);
    if (!ip) break;
    client = ip;
    if (!trusted.check(ip, ipFamily(ip))) break;
  }
  return client;
}

export interface CookieOptions {
  secure: boolean;
}

/** How the Secure flag on the session, CSRF and setup cookies is chosen.
 * `true` and `false` are fixed (the COOKIE_SECURE override). 'auto' is an
 * https installation: Secure on every address except a loopback one. A cookie
 * for localhost never leaves the machine, so Secure adds nothing there, and
 * the Josi app on the same PC (a .NET cookie jar talking to http://localhost)
 * would drop it, which is what used to need a hand edit of runtime.json once
 * a public https address was set. */
export type CookieSecurePolicy = boolean | 'auto';

export function isLoopbackHost(host: string | undefined): boolean {
  const h = (host ?? '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
}

export function cookieSecureFor(req: Request, policy: CookieSecurePolicy): boolean {
  if (policy !== 'auto') return policy;
  return !isLoopbackHost(req.hostname);
}

export function setSessionCookie(res: Response, token: string, ttlSeconds: number, opts: CookieOptions): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSeconds * 1000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** Carries an MFA challenge across a full-page redirect, which /login?mfa=pending
 * picks up. A cookie, not a query parameter, so proof of the first factor stays
 * out of URLs and history, and is good only in the browser that earned it. */
export function setMfaChallengeCookie(res: Response, challenge: string, opts: CookieOptions): void {
  res.cookie(MFA_CHALLENGE_COOKIE, challenge, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/api/auth/mfa',
    maxAge: 5 * 60 * 1000,
  });
}

export function clearMfaChallengeCookie(res: Response): void {
  res.clearCookie(MFA_CHALLENGE_COOKIE, { path: '/api/auth/mfa' });
}

/** Ties a web Google sign-in to the browser that started it. Without this, a
 * callback link from someone else's finished sign-in would log the visitor into
 * that person's account, and whatever the visitor did next would land there.
 * Lax still rides the top-level redirect back from Google. */
export function setGoogleStateCookie(res: Response, state: string, opts: CookieOptions): void {
  res.cookie(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/api/auth/google',
    maxAge: 10 * 60 * 1000,
  });
}

export function clearGoogleStateCookie(res: Response): void {
  res.clearCookie(GOOGLE_STATE_COOKIE, { path: '/api/auth/google' });
}

export function holdsGoogleState(req: Request, state: string): boolean {
  const held = readCookie(req, GOOGLE_STATE_COOKIE);
  return !!held && safeEqual(held, state);
}

/** Readable by design: the SPA has to echo it back in a header. Secrecy from
 * the page is not what protects it — same-origin policy is, because a hostile
 * origin can read neither the cookie nor set the header. */
export function issueCsrfToken(res: Response, opts: CookieOptions): string {
  const token = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: opts.secure,
    sameSite: 'lax',
    path: '/',
  });
  return token;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Refuses any state-changing request whose header token does not match its
 * cookie.
 *
 * Login is NOT exempt. A forged cross-site login would let an attacker sign a
 * victim's browser into an account the attacker controls, and everything the
 * victim then did would land in it. The client fetches a token from
 * `/api/auth/csrf` before posting credentials. */
export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const nativeLogin = req.path === '/auth/login'
    || req.path === '/auth/mfa/verify-login'
    || req.path === '/auth/google/native/exchange'
    || req.path === '/auth/apple/native/exchange'
    || req.path === '/auth/apple/native/complete';
  const nativeBearer = /^Bearer\s+[^\s]+$/i.test(req.header('authorization') ?? '');
  if (isNativeClient(req) && (nativeLogin || nativeBearer)) {
    next();
    return;
  }
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  const cookie = readCookie(req, CSRF_COOKIE);
  const header = req.header(CSRF_HEADER);
  if (!cookie || !header || !safeEqual(cookie, header)) {
    res.status(403).json({ error: 'missing or invalid CSRF token' });
    return;
  }
  next();
}
