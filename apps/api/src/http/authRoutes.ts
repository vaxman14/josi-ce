import { createHash, randomBytes } from 'node:crypto';
import { Router } from 'express';
import {
  SESSION_TTL_SECONDS, consumeAuthToken, createSession, issueAuthToken, login, peekAuthToken,
  revokeSession, setPassword, verifyPassword,
} from '@josi-ce/auth';
import { appendEvent, loadMasterKey, openSealed, seal, type Db, type LoadOptions } from '@josi-ce/core';
import { loadProfile, smtpTransport, type SmtpTransport } from '@josi-ce/mail';
import { buildAuthUrl, exchangeCode, fetchIdentity, loadClient } from '@josi-ce/connectors';
import { generateSecret, generateURI, verify } from 'otplib';
import QRCode from 'qrcode';
import { asyncRoute, param } from './async.js';
import { clearSessionCookie, clientIp, isNativeClient, issueCsrfToken, setSessionCookie } from './cookies.js';
import { requireAuth } from './authz.js';

export interface AuthRoutesCtx {
  db: Db;
  cookieSecure: boolean;
  appUrl: string;
  masterKey?: LoadOptions | false;
  mailTransport?: SmtpTransport;
  connectorFetch?: typeof fetch;
}

export function authRoutes(ctx: AuthRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  const cookieOpts = { secure: ctx.cookieSecure };

  async function publicAppUrl(): Promise<string> {
    const [deployment] = await db.query<{ domain: string | null }>(
      `select domain from deployment_config where id = true`,
    );
    const domain = deployment?.domain?.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
    return domain ? `https://${domain}` : ctx.appUrl.replace(/\/$/, '');
  }

  /** Hands the SPA a CSRF token before it posts anything, including login. */
  r.get('/csrf', (_req, res) => {
    res.json({ csrfToken: issueCsrfToken(res, cookieOpts) });
  });

  r.post(
    '/login',
    asyncRoute(async (req, res) => {
      const { identifier, password, rememberMe } = (req.body ?? {}) as { identifier?: string; password?: string; rememberMe?: boolean };
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

      const [mfa] = await db.query<{ totp_secret_enc: string | null; mfa_enabled_at: string | null }>(
        `select totp_secret_enc, mfa_enabled_at from users where id = $1`, [result.user.id],
      );
      if (mfa?.totp_secret_enc && mfa.mfa_enabled_at && ctx.masterKey !== false) {
        const challenge = randomBytes(32).toString('base64url');
        await db.query(
          `insert into auth_mfa_challenges (user_id, token_hash, remember_me, ip, user_agent, expires_at)
           values ($1,$2,$3,$4,$5,now() + interval '5 minutes')`,
          [result.user.id, createHash('sha256').update(challenge).digest('hex'), !!rememberMe, ip, req.header('user-agent')?.slice(0, 400) ?? null],
        );
        return res.status(202).json({ mfaRequired: true, challenge });
      }

      const ttlSeconds = rememberMe ? SESSION_TTL_SECONDS : 60 * 60 * 12;
      const { token } = await createSession(db, {
        userId: result.user.id,
        ip,
        userAgent: req.header('user-agent'),
        ttlSeconds,
      });
      setSessionCookie(res, token, ttlSeconds, cookieOpts);
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
      return res.json({
        user: publicUser(result.user),
        ...(isNativeClient(req) ? { sessionToken: token } : {}),
      });
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

  r.post('/forgot-password', asyncRoute(async (req, res) => {
    const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim().slice(0, 320) : '';
    if (identifier) {
      const [user] = await db.query<{ id: string; email: string }>(
        `select id, email from users where status = 'active' and (lower(email) = lower($1) or lower(username) = lower($1)) limit 1`,
        [identifier],
      );
      if (user && ctx.masterKey !== false) {
        try {
          const { token } = await issueAuthToken(db, { userId: user.id, purpose: 'reset' });
          const profile = await loadProfile(db, loadMasterKey(ctx.masterKey ?? {}), 'system');
          const transport = ctx.mailTransport ?? smtpTransport(profile);
          const base = await publicAppUrl();
          await transport.send({
            from: `${profile.fromName} <${profile.fromAddress}>`, replyTo: profile.fromAddress,
            to: [user.email], cc: [], subject: 'Reset your Josi password',
            text: `Use this one-time link within one hour:\n\n${base}/set-password?token=${token}\n\nIf you did not request this, ignore this message.`,
            headers: { 'Auto-Submitted': 'auto-generated' }, attachments: [],
          });
        } catch {
          // The public response deliberately stays identical for unknown users,
          // absent SMTP, and delivery failures. Enumeration buys an attacker
          // information and gives the owner nothing useful.
        }
      }
    }
    return res.json({ ok: true, message: 'If that account exists and system email is configured, a reset link is on its way.' });
  }));

  r.get('/google/start', asyncRoute(async (_req, res) => {
    if (ctx.masterKey === false) return res.redirect('/login?error=google_unavailable');
    let key; let saved;
    try {
      key = loadMasterKey(ctx.masterKey ?? {});
      saved = await loadClient(db, key, 'google');
    } catch {
      return res.redirect('/login?error=google_unavailable');
    }
    const redirectUri = `${await publicAppUrl()}/api/auth/google/callback`;
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await db.query(
      `insert into auth_oauth_states (state_hash, verifier, return_path, expires_at)
       values ($1, $2, '/app', now() + interval '10 minutes')`,
      [createHash('sha256').update(state).digest('hex'), seal(key, { verifier })],
    );
    return res.redirect(buildAuthUrl(
      { ...saved, redirectUri },
      { state, scopes: 'openid email profile', codeChallenge: challenge },
    ));
  }));

  r.post('/mfa/verify-login', asyncRoute(async (req, res) => {
    const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
    if (!challenge || !code || ctx.masterKey === false) return res.status(401).json({ error: 'That verification code did not work.' });
    const [row] = await db.query<{ id: string; user_id: string; remember_me: boolean; totp_secret_enc: string }>(
      `select c.id, c.user_id, c.remember_me, u.totp_secret_enc
       from auth_mfa_challenges c join users u on u.id = c.user_id
       where c.token_hash = $1 and c.used_at is null and c.expires_at > now() and c.attempts < 5 and u.status = 'active'`,
      [createHash('sha256').update(challenge).digest('hex')],
    );
    if (!row) return res.status(401).json({ error: 'That verification code did not work.' });
    const key = loadMasterKey(ctx.masterKey ?? {});
    const secret = openSealed<{ secret: string }>(key, row.totp_secret_enc).secret;
    const totp = (await verify({ secret, token: code, epochTolerance: 30 })).valid;
    let recovery = false;
    if (!totp) {
      const used = await db.query<{ id: string }>(
        `update mfa_recovery_codes set used_at = now()
         where user_id = $1 and code_hash = $2 and used_at is null returning id`,
        [row.user_id, createHash('sha256').update(code.toUpperCase()).digest('hex')],
      );
      recovery = used.length > 0;
    }
    if (!totp && !recovery) {
      await db.query(`update auth_mfa_challenges set attempts = least(attempts + 1, 5) where id = $1`, [row.id]);
      return res.status(401).json({ error: 'That verification code did not work.' });
    }
    await db.query(`update auth_mfa_challenges set used_at = now() where id = $1`, [row.id]);
    const ttlSeconds = row.remember_me ? SESSION_TTL_SECONDS : 60 * 60 * 12;
    const session = await createSession(db, { userId: row.user_id, ip: clientIp(req), userAgent: req.header('user-agent'), ttlSeconds });
    setSessionCookie(res, session.token, ttlSeconds, cookieOpts); issueCsrfToken(res, cookieOpts);
    const [user] = await db.query<{ id: string; email: string; username: string; role: string; display_name: string | null }>(
      `select id,email,username,role,display_name from users where id = $1`, [row.user_id],
    );
    return res.json({ user: publicUser(user) });
  }));

  r.get('/mfa', requireAuth, asyncRoute(async (req, res) => {
    const [row] = await db.query<{ mfa_enabled_at: string | null }>(`select mfa_enabled_at from users where id = $1`, [req.user!.id]);
    const [codes] = await db.query<{ n: number }>(`select count(*)::int n from mfa_recovery_codes where user_id = $1 and used_at is null`, [req.user!.id]);
    return res.json({ enabled: !!row?.mfa_enabled_at, recoveryCodesRemaining: codes?.n ?? 0 });
  }));

  r.post('/mfa/setup', requireAuth, asyncRoute(async (req, res) => {
    if (ctx.masterKey === false) return res.status(503).json({ error: 'This installation cannot store MFA secrets.' });
    const [current] = await db.query<{ mfa_enabled_at: string | null }>(
      `select mfa_enabled_at from users where id = $1`, [req.user!.id],
    );
    // Never replace a working factor merely because an authenticated browser
    // called setup again. Disabling MFA requires the account password below.
    if (current?.mfa_enabled_at) return res.status(409).json({ error: 'MFA is already enabled. Disable it before setting up a new authenticator.' });
    const secret = generateSecret(); const key = loadMasterKey(ctx.masterKey ?? {});
    await db.query(`update users set totp_secret_enc = $2, mfa_enabled_at = null where id = $1`, [req.user!.id, seal(key, { secret })]);
    const uri = generateURI({ issuer: 'Josi CE', label: req.user!.email, secret });
    return res.json({ secret, qrDataUrl: await QRCode.toDataURL(uri) });
  }));

  r.post('/mfa/enable', requireAuth, asyncRoute(async (req, res) => {
    if (ctx.masterKey === false) return res.status(503).json({ error: 'This installation cannot store MFA secrets.' });
    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
    const [row] = await db.query<{ totp_secret_enc: string | null }>(`select totp_secret_enc from users where id = $1`, [req.user!.id]);
    if (!row?.totp_secret_enc) return res.status(409).json({ error: 'Start MFA setup first.' });
    const secret = openSealed<{ secret: string }>(loadMasterKey(ctx.masterKey ?? {}), row.totp_secret_enc).secret;
    if (!(await verify({ secret, token: code, epochTolerance: 30 })).valid) return res.status(400).json({ error: 'That code did not match.' });
    const codes = Array.from({ length: 10 }, () => `${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`.toUpperCase());
    await db.query(`delete from mfa_recovery_codes where user_id = $1`, [req.user!.id]);
    for (const recovery of codes) await db.query(`insert into mfa_recovery_codes (user_id, code_hash) values ($1,$2)`,
      [req.user!.id, createHash('sha256').update(recovery).digest('hex')]);
    await db.query(`update users set mfa_enabled_at = now() where id = $1`, [req.user!.id]);
    await appendEvent(db, { actorUserId: req.user!.id, actor: 'user', kind: 'auth.mfa_enabled', subjectType: 'user', subjectId: req.user!.id });
    return res.json({ enabled: true, recoveryCodes: codes });
  }));

  r.post('/mfa/disable', requireAuth, asyncRoute(async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const [account] = await db.query<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [req.user!.id]);
    if (!(await verifyPassword(account?.password_hash ?? null, password))) return res.status(401).json({ error: 'That password did not match.' });
    await db.query(`update users set totp_secret_enc = null, mfa_enabled_at = null where id = $1`, [req.user!.id]);
    await db.query(`delete from mfa_recovery_codes where user_id = $1`, [req.user!.id]);
    await appendEvent(db, { actorUserId: req.user!.id, actor: 'user', kind: 'auth.mfa_disabled', subjectType: 'user', subjectId: req.user!.id });
    return res.json({ enabled: false });
  }));
  r.get('/google/callback', asyncRoute(async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!state || !code || ctx.masterKey === false) return res.redirect('/login?error=google_signin_failed');
    const key = loadMasterKey(ctx.masterKey ?? {});
    const rows = await db.query<{ verifier: string }>(
      `update auth_oauth_states set used_at = now()
       where state_hash = $1 and used_at is null and expires_at > now()
       returning verifier`,
      [createHash('sha256').update(state).digest('hex')],
    );
    if (!rows.length) return res.redirect('/login?error=google_signin_expired');
    const verifier = openSealed<{ verifier: string }>(key, rows[0].verifier).verifier;
    const saved = await loadClient(db, key, 'google');
    const redirectUri = `${await publicAppUrl()}/api/auth/google/callback`;
    const tokens = await exchangeCode(
      { ...saved, redirectUri },
      { code, verifier, scopes: 'openid email profile' },
      { fetchImpl: ctx.connectorFetch },
    );
    const identity = await fetchIdentity('google', tokens.accessToken, { fetchImpl: ctx.connectorFetch });
    const [user] = await db.query<{ id: string; email: string; username: string; role: string; display_name: string | null }>(
      `select distinct u.id, u.email, u.username, u.role, u.display_name
       from users u join connections c on c.owner_user_id = u.id
       where u.status = 'active' and c.provider = 'google' and c.status = 'active'
         and ((c.provider_account_id is not null and c.provider_account_id = $1)
           or (c.account_email is not null and lower(c.account_email) = lower($2)))
       limit 1`,
      [identity.accountId, identity.email],
    );
    if (!user) return res.redirect('/login?error=google_not_linked');
    const ttlSeconds = SESSION_TTL_SECONDS;
    const { token } = await createSession(db, {
      userId: user.id, ip: clientIp(req), userAgent: req.header('user-agent'), ttlSeconds,
    });
    setSessionCookie(res, token, ttlSeconds, cookieOpts); issueCsrfToken(res, cookieOpts);
    await appendEvent(db, { actorUserId: user.id, actor: 'user', kind: 'auth.google_login', subjectType: 'user', subjectId: user.id });
    return res.redirect('/app');
  }));

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
