// The boundary between "being installed" and "installed".
//
// Two rules, and they are mirror images:
//
//   before completion — /api/setup/* works, everything else under /api is
//                       refused. An unconfigured installation has no accounts,
//                       so any other route would be operating without an
//                       authorization model to enforce.
//
//   after completion  — /api/setup/* returns 404 and everything else works.
//                       404 rather than 403 or a redirect: after setup those
//                       routes do not exist, and saying "forbidden" would
//                       advertise a super-admin factory that used to be there.
//
// The state is read from the database on every request rather than cached at
// boot, so a process that started mid-setup and a process that started after it
// behave identically.
import type { NextFunction, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { getSetupState, type Db } from '@josi-ce/core';
import { clientIp, cookieSecureFor, readCookie } from './cookies.js';
import type { CookieSecurePolicy } from './cookies.js';
import { HANDOFF_TTL, SETUP_SESSION_COOKIE, SETUP_SESSION_TTL, SetupHandoffs } from './setupHandoffs.js';

/** Paths that must answer regardless of setup state.
 *
 * Deliberately tiny and explicit. `/health` and `/ready` are mounted outside
 * `/api` and never reach this middleware; this list exists only so the
 * exception is written down somewhere a reviewer will look. */
export const SETUP_EXEMPT_PREFIXES = ['/setup'] as const;

/** Safe bootstrap endpoints needed by the setup client before an account
 * exists. Keep this exact rather than prefix-based: widening `/auth` would
 * expose login and recovery routes during setup. */
const ALWAYS_AVAILABLE_PATHS = new Set(['/auth/csrf']);

/** Where Google and Microsoft send the browser back after the owner connects
 * an account in setup's email step. The address is the one registered with the
 * provider, so it cannot live under /setup. Letting it through opens nothing:
 * the route behind it acts only on an unspent handshake that setup itself
 * started, and answers 401 for anything else. */
const SETUP_OAUTH_RETURN = /^\/connections\/(google|microsoft)\/callback$/;

function isSetupPath(path: string): boolean {
  return SETUP_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** Headers a tunnel or an outside proxy adds. A request carrying one did not come straight from the LAN. */
const OUTSIDE_PROXY_HEADERS = ['cf-connecting-ip', 'cf-ray', 'forwarded', 'x-real-ip', 'true-client-ip'];

/** A client on this machine or on a private network: loopback, 10/8, 172.16/12, 192.168/16, link-local, or an IPv6 unique-local address. */
export function isPrivateClient(ip: string | null): boolean {
  if (!ip) return false;
  if (ip === '::1' || /^f[cd][0-9a-f]{2}:/i.test(ip) || /^fe80:/i.test(ip)) return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(ip);
  if (!m) return false;
  const a = Number(m[1]), b = Number(m[2]);
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export interface SetupGateOptions {
  /** The first person to open an unconfigured, LAN-only install may start its setup without the setup link. Off unless the installer says so (the Docker image does). */
  openSetup?: boolean;
}

export function setupGate(db: Db, setupTokenSha256?: string | null, cookieSecure: CookieSecurePolicy = false, options: SetupGateOptions = {}) {
  const handoffs = new SetupHandoffs();
  // Only an unconfigured install with the switch on, and only for a client
  // that is itself on the LAN and did not come through a tunnel or proxy.
  const openAllowed = (req: Request) => options.openSetup === true
    && isPrivateClient(clientIp(req))
    && !OUTSIDE_PROXY_HEADERS.some((h) => req.headers[h] !== undefined);
  const expected = setupTokenSha256
    ? Buffer.from(setupTokenSha256, 'hex')
    : null;
  if (setupTokenSha256 && (!/^[a-f0-9]{64}$/.test(setupTokenSha256) || expected?.length !== 32)) {
    throw new Error('JOSI_SETUP_TOKEN_SHA256 must be a lowercase SHA-256 digest');
  }
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let completed: boolean;
    try {
      completed = (await getSetupState(db)).completed;
    } catch {
      // The database is unreachable. Refuse rather than guess: guessing
      // "completed" would expose the application without its authorization
      // model, and guessing "not completed" would reopen the wizard.
      res.status(503).json({ error: 'this installation is not available right now' });
      return;
    }

    const setupPath = isSetupPath(req.path);
    const rootAuthorized = () => !!expected && timingSafeEqual(
      createHash('sha256').update(req.get('x-josi-setup-token') ?? '').digest(), expected);

    if (req.path === '/onboarding/state' && req.method === 'GET' && expected) {
      res.set('Cache-Control', 'no-store').json({ completed, ...(!completed && openAllowed(req) ? { openSetup: true } : {}) }); return;
    }
    if (req.path === '/onboarding/launch' || req.path === '/onboarding/consume' || req.path === '/onboarding/claim') {
      res.set('Cache-Control', 'no-store');
      if (completed || !expected || req.method !== 'POST') {
        res.status(404).json({ error: 'not found' }); return;
      }
      if (req.path === '/onboarding/claim') {
        // Same result as opening the one-use setup link, without needing it.
        if (!openAllowed(req)) { res.status(404).json({ error: 'not found' }); return; }
        let session: string | null = null;
        try { session = handoffs.consume(handoffs.issue()); } catch { /* too many pending */ }
        if (!session) { res.status(429).json({ error: 'too many setup sessions; retry shortly' }); return; }
        res.cookie(SETUP_SESSION_COOKIE, session, { httpOnly: true, secure: cookieSecureFor(req, cookieSecure),
          sameSite: 'strict', path: '/api/setup', maxAge: SETUP_SESSION_TTL });
        res.status(204).end(); return;
      }
      if (req.path === '/onboarding/launch') {
        if (!rootAuthorized()) { res.status(404).json({ error: 'not found' }); return; }
        try { res.json({ token: handoffs.issue(), expiresInSeconds: HANDOFF_TTL / 1000 }); }
        catch { res.status(429).json({ error: 'too many pending setup links; retry shortly' }); }
        return;
      }
      const session = handoffs.consume(req.body?.token);
      if (!session) { res.status(410).json({ error: 'This setup link expired or was already used. Reopen Josi to continue.' }); return; }
      res.cookie(SETUP_SESSION_COOKIE, session, { httpOnly: true, secure: cookieSecureFor(req, cookieSecure),
        sameSite: 'strict', path: '/api/setup', maxAge: SETUP_SESSION_TTL });
      res.status(204).end(); return;
    }

    if (ALWAYS_AVAILABLE_PATHS.has(req.path)) {
      next();
      return;
    }

    if (!completed) {
      if (req.method === 'GET' && SETUP_OAUTH_RETURN.test(req.path)) { next(); return; }
      if (setupPath) {
        if (expected && !handoffs.authorized(readCookie(req, SETUP_SESSION_COOKIE))) {
          const supplied = req.get('x-josi-setup-token') ?? '';
          const actual = createHash('sha256').update(supplied).digest();
          if (!timingSafeEqual(actual, expected)) {
            res.status(404).json({ error: 'not found' });
            return;
          }
        }
        next();
        return;
      }
      // Not a 404: the route genuinely exists and will work shortly. Saying so
      // is more useful to an operator than pretending it is absent, and reveals
      // nothing an unconfigured install does not already announce.
      res.status(503).json({
        error: 'this installation has not been set up yet',
        setupRequired: true,
      });
      return;
    }

    if (setupPath) {
      handoffs.clear();
      res.clearCookie(SETUP_SESSION_COOKIE, { path: '/api/setup' });
      res.status(404).json({ error: 'not found' });
      return;
    }

    next();
  };
}
