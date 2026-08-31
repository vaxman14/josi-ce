import { Router } from 'express';
import {
  SESSION_TTL_SECONDS, consumeAuthToken, createSession, login, peekAuthToken,
  revokeSession, setPassword,
} from '@josi-ce/auth';
import { appendEvent, type Db } from '@josi-ce/core';
import { asyncRoute, param } from './async.js';
import { clearSessionCookie, clientIp, issueCsrfToken, setSessionCookie } from './cookies.js';
import { requireAuth } from './authz.js';

export interface AuthRoutesCtx {
  db: Db;
  cookieSecure: boolean;
}

export function authRoutes(ctx: AuthRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  const cookieOpts = { secure: ctx.cookieSecure };

  /** Hands the SPA a CSRF token before it posts anything, including login. */
  r.get('/csrf', (_req, res) => {
    res.json({ csrfToken: issueCsrfToken(res, cookieOpts) });
  });

  r.post(
    '/login',
    asyncRoute(async (req, res) => {
      const { identifier, password } = (req.body ?? {}) as { identifier?: string; password?: string };
      if (!identifier || !password) {
        return res.status(400).json({ error: 'identifier and password required' });
      }

      const ip = clientIp(req);
      const result = await login(db, { identifier, password, ip });
      if (!result.ok) {
        if (result.reason === 'rate_limited') {
          res.set('Retry-After', String(result.verdict.retryAfterSeconds));
          return res.status(429).json({ error: 'too many attempts, try again later' });
        }
        // Identical response either way: never confirm whether an account exists.
        return res.status(401).json({ error: 'wrong username or password' });
      }

      const { token } = await createSession(db, {
        userId: result.user.id,
        ip,
        userAgent: req.header('user-agent'),
      });
      setSessionCookie(res, token, SESSION_TTL_SECONDS, cookieOpts);
      // Rotate the CSRF token on privilege change, so a token captured before
      // sign-in is not valid for the authenticated session.
      issueCsrfToken(res, cookieOpts);
      await appendEvent(db, {
        actorUserId: result.user.id,
        actor: 'user',
        kind: 'auth.login',
        subjectType: 'user',
        subjectId: result.user.id,
        payload: { ip },
      });
      return res.json({ user: publicUser(result.user) });
    }),
  );

  r.post(
    '/logout',
    asyncRoute(async (req, res) => {
      if (req.user) await revokeSession(db, req.user.session_id);
      clearSessionCookie(res);
      return res.json({ ok: true });
    }),
  );

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  /** Render-side check for the set-password form. Reveals only the username the
   * token already belongs to, and a masked address. */
  r.get(
    '/token/:token',
    asyncRoute(async (req, res) => {
      const found = await peekAuthToken(db, param(req, 'token'));
      if (!found) return res.status(404).json({ error: 'that link is expired or already used' });
      return res.json({ purpose: found.purpose, username: found.username, email: maskEmail(found.email) });
    }),
  );

  r.post(
    '/set-password',
    asyncRoute(async (req, res) => {
      const { token, password } = (req.body ?? {}) as { token?: string; password?: string };
      if (!token || !password) return res.status(400).json({ error: 'token and password required' });
      if (password.length < 12) {
        return res.status(400).json({ error: 'password must be at least 12 characters' });
      }

      const redeemed = await consumeAuthToken(db, token);
      if (!redeemed) return res.status(400).json({ error: 'that link is expired or already used' });

      await setPassword(db, redeemed.user_id, password);
      await appendEvent(db, {
        actorUserId: redeemed.user_id,
        actor: 'user',
        kind: 'auth.password_set',
        subjectType: 'user',
        subjectId: redeemed.user_id,
        payload: { via: redeemed.purpose },
      });

      // setPassword revoked every session, so the token they just burned is the
      // only proof of identity available. Sign them in with a fresh one.
      const { token: sessionToken } = await createSession(db, {
        userId: redeemed.user_id,
        ip: clientIp(req),
        userAgent: req.header('user-agent'),
      });
      setSessionCookie(res, sessionToken, SESSION_TTL_SECONDS, cookieOpts);
      issueCsrfToken(res, cookieOpts);
      const rows = await db.query<{
        id: string; email: string; username: string; role: 'super_admin' | 'member'; display_name: string | null;
      }>(`select id, email, username, role, display_name from users where id = $1`, [redeemed.user_id]);
      return res.json({ user: rows[0] });
    }),
  );

  return r;
}

function publicUser(u: {
  id: string; email: string; username: string; role: string; display_name?: string | null;
}) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    displayName: u.display_name ?? null,
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}
