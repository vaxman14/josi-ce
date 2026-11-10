import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  SESSION_TTL_SECONDS, consumeAuthToken, createSession, issueAuthToken, login, peekAuthToken,
  revokeSession, setPassword, verifyPassword, startGoogleLogin, consumeGoogleLogin, GOOGLE_NATIVE_RETURN_URI, type LoginProvider, relyingParty,
  MfaError, adoptMfa, assertCanAdoptMfa, beginMfaSetup, enableMfa, disableMfa, completeMfaLogin, verifyMfaFactor,
} from '@josi-ce/auth';
import { appendEvent, loadMasterKey, VaultError, VaultLockedError, type Db, type LoadOptions } from '@josi-ce/core';
import { loadProfile, smtpTransport, type SmtpTransport } from '@josi-ce/mail';
import { accountMailSender, buildAuthUrl, exchangeCode, fetchIdentity, hostedCall, hostedLink, loadClient } from '@josi-ce/connectors';
import { generateURI } from 'otplib';
import QRCode from 'qrcode';
import { asyncRoute, param } from './async.js';
import {
  MFA_CHALLENGE_COOKIE, clearGoogleStateCookie, clearMfaChallengeCookie, clearSessionCookie, clientIp, cookieSecureFor, holdsGoogleState,
  isNativeClient, issueCsrfToken, readCookie, setGoogleStateCookie, setMfaChallengeCookie, setSessionCookie,
} from './cookies.js';
import type { CookieSecurePolicy } from './cookies.js';
import { requireAuth } from './authz.js';
import { verifyAppleIdentityToken } from './appleIdentity.js';
import { issueNativeCode, nativeCallback } from './nativeCodes.js';

export interface AuthRoutesCtx {
  db: Db;
  cookieSecure: CookieSecurePolicy;
  appUrl: string;
  masterKey?: LoadOptions | false;
  mailTransport?: SmtpTransport;
  connectorFetch?: typeof fetch;
  appleNativeClientId?: string | null;
  appleFetch?: typeof fetch;
  passkeysEnabled?: boolean;
}

const mfaRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); }
  catch (err) {
    if (err instanceof MfaError) return res.status(err.status).json({ error: err.message });
    if (err instanceof VaultLockedError) return res.status(423).json({ error: err.message, code: 'vault_locked' });
    if (err instanceof VaultError) return res.status(409).json({ error: err.message });
    throw err;
  }
});

export function authRoutes(ctx: AuthRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  const cookieOpts = (req: Request) => ({ secure: cookieSecureFor(req, ctx.cookieSecure) });
  function mfaKey() {
    try { return ctx.masterKey === false ? null : loadMasterKey(ctx.masterKey ?? {}); }
    catch { return null; } // Recovery codes still require the existing first factor.
  }

  /** The first factor is proven and no session exists yet. Only
   * /auth/mfa/verify-login turns this into one. */
  async function issueMfaChallenge(req: Request, userId: string, rememberMe: boolean): Promise<string> {
    const challenge = randomBytes(32).toString('base64url');
    await db.query(
      `insert into auth_mfa_challenges (user_id, token_hash, remember_me, ip, user_agent, expires_at)
       values ($1,$2,$3,$4,$5,now() + interval '5 minutes')`,
      [userId, createHash('sha256').update(challenge).digest('hex'), rememberMe, clientIp(req), req.header('user-agent')?.slice(0, 400) ?? null],
    );
    return challenge;
  }

  async function publicAppUrl(): Promise<string> {
    // APP_URL is the canonical browser-facing origin chosen by the installer.
    // Reconstructing it from deployment_config.domain discarded LAN HTTP and
    // non-default ports, producing unusable https://<LAN-IP>/set-password links.
    return ctx.appUrl.replace(/\/$/, '');
  }

  const NATIVE_GOOGLE_RETURN_URI = GOOGLE_NATIVE_RETURN_URI;

  /** What each provider is asked for at sign-in: who this is, nothing else.
   * Microsoft says who through Graph, which needs User.Read. */
  const LOGIN_SCOPES: Record<LoginProvider, string> = { google: 'openid email profile', microsoft: 'openid email profile User.Read' };

  async function startLogin(provider: LoginProvider, returnUri: string | null, req: Request, res: Response) {
    const unavailable = `${provider}_unavailable`;
    if (returnUri !== null && returnUri !== NATIVE_GOOGLE_RETURN_URI) {
      return res.status(400).json({ error: 'unsupported native redirect URI' });
    }
    if (ctx.masterKey === false) {
      return returnUri
        ? res.redirect(nativeCallback(returnUri, { error: unavailable }))
        : res.redirect(`/login?error=${unavailable}`);
    }
    let key; let saved;
    try {
      key = loadMasterKey(ctx.masterKey ?? {});
      saved = await loadClient(db, key, provider);
    } catch {
      return returnUri
        ? res.redirect(nativeCallback(returnUri, { error: unavailable }))
        : res.redirect(`/login?error=${unavailable}`);
    }
    const redirectUri = `${await publicAppUrl()}/api/auth/${provider}/callback`;
    let started;
    try { started = await startGoogleLogin(db, key, returnUri, provider); }
    catch { return returnUri ? res.redirect(nativeCallback(returnUri, { error: unavailable })) : res.redirect(`/login?error=${unavailable}`); }
    // A native app checks state itself, and its browser never saw this request.
    if (returnUri === null) setGoogleStateCookie(res, started.state, cookieOpts(req));
    return res.redirect(buildAuthUrl(
      { ...saved, redirectUri },
      { state: started.state, scopes: LOGIN_SCOPES[provider], codeChallenge: started.challenge },
    ));
  }
  const startGoogle = (returnUri: string | null, req: Request, res: Response) => startLogin('google', returnUri, req, res);

  /** Hands the SPA a CSRF token before it posts anything, including login. */
  r.get('/csrf', (req, res) => {
    res.json({ csrfToken: issueCsrfToken(res, cookieOpts(req)) });
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
      if (mfa?.mfa_enabled_at) {
        const challenge = await issueMfaChallenge(req, result.user.id, rememberMe === true || (isNativeClient(req) && rememberMe !== false));
        return res.status(202).json({ mfaRequired: true, challenge });
      }

      // Native clients keep their bearer token in the OS secure store and do
      // not present a browser-style "remember me" checkbox. Treat an omitted
      // value as persistent for native clients; an explicit false still opts
      // into the short session.
      const persistent = rememberMe === true || (isNativeClient(req) && rememberMe !== false);
      const ttlSeconds = persistent ? SESSION_TTL_SECONDS : 60 * 60 * 12;
      const { token } = await createSession(db, {
        userId: result.user.id,
        ip,
        userAgent: req.header('user-agent'),
        ttlSeconds,
      });
      setSessionCookie(res, token, ttlSeconds, cookieOpts(req));
      // Rotate the CSRF token on privilege change, so a token captured before
      // sign-in is not valid for the authenticated session.
      issueCsrfToken(res, cookieOpts(req));
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
          const mailKey = loadMasterKey(ctx.masterKey ?? {});
          const account = await accountMailSender(db, mailKey, { fetchImpl: ctx.connectorFetch });
          const profile = account?.profile ?? await loadProfile(db, mailKey, 'system');
          const transport = ctx.mailTransport ?? account?.transport ?? smtpTransport(profile as Awaited<ReturnType<typeof loadProfile>>);
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

  r.get('/google/start', asyncRoute(async (req, res) => {
    // Google returns to APP_URL, so that is where the state cookie has to be set,
    // whatever address this page was opened on. Once only: a proxy that rewrites
    // Host would otherwise send this back here forever.
    const canonical = new URL(await publicAppUrl());
    if (req.query.canonical !== '1' && req.get('host') !== canonical.host) {
      return res.redirect(`${canonical.origin}/api/auth/google/start?canonical=1`);
    }
    return startGoogle(null, req, res);
  }));

  r.get('/microsoft/start', asyncRoute(async (req, res) => {
    // Same hop as Google: the state cookie belongs to the address Microsoft returns to.
    const canonical = new URL(await publicAppUrl());
    if (req.query.canonical !== '1' && req.get('host') !== canonical.host) {
      return res.redirect(`${canonical.origin}/api/auth/microsoft/start?canonical=1`);
    }
    return startLogin('microsoft', null, req, res);
  }));

  r.get('/google/native/start', asyncRoute(async (req, res) => {
    const returnUri = typeof req.query.redirect_uri === 'string' ? req.query.redirect_uri : '';
    return startGoogle(returnUri, req, res);
  }));

  // The same for Microsoft. The iPhone app names the parameter return_uri;
  // both names are read, and the allow-list is Google's.
  r.get('/microsoft/native/start', asyncRoute(async (req, res) => {
    const named = typeof req.query.return_uri === 'string' ? req.query.return_uri : req.query.redirect_uri;
    return startLogin('microsoft', typeof named === 'string' ? named : '', req, res);
  }));

  r.get('/native/config', asyncRoute(async (_req, res) => {
    let googleSignIn = false, microsoftSignIn = false;
    if (ctx.masterKey !== false) {
      const key = loadMasterKey(ctx.masterKey ?? {});
      try {
        await loadClient(db, key, 'google');
        googleSignIn = true;
      } catch { /* configuration is intentionally reported only as a boolean */ }
      try { await loadClient(db, key, 'microsoft'); microsoftSignIn = true; } catch { /* the same */ }
    }
    const appUrl = await publicAppUrl();
    const enrollmentDeepLink = appUrl.startsWith('https://')
      ? `josi://enroll?server=${encodeURIComponent(appUrl)}`
      : null;
    res.set('Cache-Control', 'no-store');
    return res.json({
      appUrl,
      googleSignIn,
      appleSignIn: !!ctx.appleNativeClientId,
      nativeGoogleStart: `${appUrl}/api/auth/google/native/start`,
      microsoftSignIn,
      nativeMicrosoftStart: `${appUrl}/api/auth/microsoft/native/start`,
      passkeySignIn: ctx.passkeysEnabled !== false && !!relyingParty(ctx.appUrl),
      nativePasskeyStart: `${appUrl}/api/auth/passkey/native/start`,
      enrollmentDeepLink,
    });
  }));

  r.post('/mfa/verify-login', mfaRoute(async (req, res) => {
    const result = await completeMfaLogin(db, mfaKey(), {
      // After a redirect the page never saw the challenge, so it rides in a cookie.
      challenge: (typeof req.body?.challenge === 'string' && req.body.challenge) || readCookie(req, MFA_CHALLENGE_COOKIE) || '',
      code: typeof req.body?.code === 'string' ? req.body.code : '',
      ip: clientIp(req), userAgent: req.header('user-agent'),
    });
    if (!result) return res.status(401).json({ error: 'That verification code did not work.' });
    clearMfaChallengeCookie(res);
    setSessionCookie(res, result.token, result.ttlSeconds, cookieOpts(req)); issueCsrfToken(res, cookieOpts(req));
    return res.json({ user: publicUser(result.user), ...(isNativeClient(req) ? { sessionToken: result.token } : {}) });
  }));

  r.get('/mfa', requireAuth, asyncRoute(async (req, res) => {
    const [row] = await db.query<{ mfa_enabled_at: string | null }>(`select mfa_enabled_at from users where id = $1`, [req.user!.id]);
    const [codes] = await db.query<{ n: number }>(`select count(*)::int n from mfa_recovery_codes where user_id = $1 and used_at is null`, [req.user!.id]);
    return res.json({ enabled: !!row?.mfa_enabled_at, recoveryCodesRemaining: codes?.n ?? 0, heyJosiLinked: !!(await hostedLink(db)) });
  }));

  r.post('/mfa/setup', requireAuth, mfaRoute(async (req, res) => {
    const key = mfaKey();
    if (!key) throw new MfaError(503, 'This installation cannot store MFA secrets.');
    const secret = await beginMfaSetup(db, key, req.user!.id);
    const uri = generateURI({ issuer: 'Josi', label: req.user!.email, secret });
    return res.json({ secret, qrDataUrl: await QRCode.toDataURL(uri) });
  }));

  r.post('/mfa/enable', requireAuth, mfaRoute(async (req, res) => {
    const key = mfaKey();
    if (!key) throw new MfaError(503, 'This installation cannot store MFA secrets.');
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    const codes = await enableMfa(db, key, req.user!.id, code);
    return res.json({ enabled: true, recoveryCodes: codes });
  }));

  /** One authenticator across the platform: uses the one on the Hey Josi account. */
  r.post('/mfa/share', requireAuth, mfaRoute(async (req, res) => {
    const key = mfaKey();
    if (!key) throw new MfaError(503, 'This installation cannot store MFA secrets.');
    await assertCanAdoptMfa(db, key, req.user!.id, typeof req.body?.password === 'string' ? req.body.password : '');
    if (!await hostedLink(db)) throw new MfaError(409, 'Link this server to your Hey Josi account first.');
    let reply;
    try { reply = await hostedCall<{ secret: string }>(db, { op: 'totp.share', code: typeof req.body?.code === 'string' ? req.body.code : '' }, { fetchImpl: ctx.connectorFetch }); }
    catch { throw new MfaError(502, 'Could not reach Hey Josi. Try again in a moment.'); }
    if (!reply.ok) throw new MfaError(400, reply.message ?? 'That code did not match.');
    return res.json({ enabled: true, recoveryCodes: await adoptMfa(db, key, req.user!.id, reply.secret) });
  }));

  r.post('/mfa/disable', requireAuth, mfaRoute(async (req, res) => {
    await disableMfa(db, req.user!.id, typeof req.body?.password === 'string' ? req.body.password : '');
    return res.json({ enabled: false });
  }));
  const loginCallback = (provider: LoginProvider) => asyncRoute(async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const providerError = typeof req.query.error === 'string' ? req.query.error : '';
    if (!state || ctx.masterKey === false) return res.redirect(`/login?error=${provider}_signin_failed`);
    let key; let pending;
    try {
      key = loadMasterKey(ctx.masterKey ?? {});
      pending = await consumeGoogleLogin(db, key, state, !providerError && !!code, provider);
    } catch {
      // Preserve the native error return without opening a credential or
      // trusting an arbitrary stored URI. The valid state remains unconsumed.
      const [hint] = await db.query<{ native_return_uri: string | null }>(
        'select native_return_uri from auth_oauth_states where state_hash=$1 and used_at is null and expires_at>now()',
        [createHash('sha256').update(state).digest('hex')],
      );
      return hint?.native_return_uri === NATIVE_GOOGLE_RETURN_URI
        ? res.redirect(nativeCallback(NATIVE_GOOGLE_RETURN_URI, { error: `${provider}_unavailable`, state }))
        : res.redirect(`/login?error=${provider}_unavailable`);
    }
    if (!pending) return res.redirect(`/login?error=${provider}_signin_expired`);
    if (providerError || !code) {
      const error = providerError === 'access_denied' ? `${provider}_declined` : `${provider}_signin_failed`;
      return pending.nativeReturnUri
        ? res.redirect(nativeCallback(pending.nativeReturnUri, { error, state }))
        : res.redirect(`/login?error=${error}`);
    }
    if (!pending.nativeReturnUri) {
      const ours = holdsGoogleState(req, state);
      clearGoogleStateCookie(res);
      if (!ours) return res.redirect(`/login?error=${provider}_signin_failed`);
    }
    const verifier = pending.verifier!;
    const saved = await loadClient(db, key, provider);
    const redirectUri = `${await publicAppUrl()}/api/auth/${provider}/callback`;
    const tokens = await exchangeCode(
      { ...saved, redirectUri },
      { code, verifier, scopes: LOGIN_SCOPES[provider] },
      { fetchImpl: ctx.connectorFetch },
    );
    const identity = await fetchIdentity(provider, tokens.accessToken, { fetchImpl: ctx.connectorFetch });
    const [user] = await db.query<{ id: string; email: string; username: string; role: string; display_name: string | null; mfa_enabled_at: string | null }>(
      `select distinct u.id, u.email, u.username, u.role, u.display_name, u.mfa_enabled_at
       from users u join connections c on c.owner_user_id = u.id
       where u.status = 'active' and c.provider = $3 and c.status = 'active'
         and ((c.provider_account_id is not null and c.provider_account_id = $1)
           or (c.account_email is not null and lower(c.account_email) = lower($2)))
       limit 1`,
      [identity.accountId, identity.email, provider],
    );
    if (!user) {
      return pending.nativeReturnUri
        ? res.redirect(nativeCallback(pending.nativeReturnUri, { error: `${provider}_not_linked`, state }))
        : res.redirect(`/login?error=${provider}_not_linked`);
    }
    if (pending.nativeReturnUri) {
      const nativeCode = await issueNativeCode(db, user.id, `auth.${provider}_native_code_issued`);
      return res.redirect(nativeCallback(pending.nativeReturnUri, { code: nativeCode, state }));
    }
    // The provider answers for the first factor only, like an emailed code.
    if (user.mfa_enabled_at) {
      setMfaChallengeCookie(res, await issueMfaChallenge(req, user.id, true), cookieOpts(req));
      return res.redirect('/login?mfa=pending');
    }
    const ttlSeconds = SESSION_TTL_SECONDS;
    const { token } = await createSession(db, {
      userId: user.id, ip: clientIp(req), userAgent: req.header('user-agent'), ttlSeconds,
    });
    setSessionCookie(res, token, ttlSeconds, cookieOpts(req)); issueCsrfToken(res, cookieOpts(req));
    await appendEvent(db, { actorUserId: user.id, actor: 'user', kind: `auth.${provider}_login`, subjectType: 'user', subjectId: user.id });
    return res.redirect('/app');
  });
  r.get('/google/callback', loginCallback('google'));
  r.get('/microsoft/callback', loginCallback('microsoft'));

  /** Redeems a code from any browser sign-in. The code does not record how it was
   * earned, so the route says what to write in the audit log: a passkey sign-in
   * goes through the neutral route and is never logged as a Google one. */
  const exchangeNativeCode = (loginEvent: string) => asyncRoute(async (req, res) => {
    if (!isNativeClient(req)) return res.status(403).json({ error: 'native client required' });
    const code = typeof req.body?.code === 'string' ? req.body.code : '';
    if (!code) return res.status(400).json({ error: 'code required' });
    const [redeemed] = await db.query<{
      user_id: string; id: string; email: string; username: string; role: string; display_name: string | null; mfa_enabled_at: string | null; passkey_proved: boolean; pc_control_allowed: boolean;
    }>(
      `with claimed as (
         update auth_native_codes set used_at = now()
         where code_hash = $1 and used_at is null and expires_at > now()
         returning user_id, passkey_proved
       )
       select c.user_id, c.passkey_proved, u.id, u.email, u.username, u.role, u.display_name, u.mfa_enabled_at, u.pc_control_allowed
       from claimed c join users u on u.id = c.user_id
       where u.status = 'active'`,
      [createHash('sha256').update(code).digest('hex')],
    );
    if (!redeemed) return res.status(401).json({ error: 'invalid or expired code' });
    // The same answer /auth/login gives. The app finishes at /auth/mfa/verify-login.
    // A passkey already verified the person, as it does on the web sign-in.
    if (redeemed.mfa_enabled_at && !redeemed.passkey_proved) {
      return res.status(202).json({ mfaRequired: true, challenge: await issueMfaChallenge(req, redeemed.user_id, true) });
    }
    const { token } = await createSession(db, {
      userId: redeemed.user_id, ip: clientIp(req), userAgent: req.header('user-agent'), ttlSeconds: SESSION_TTL_SECONDS,
    });
    await appendEvent(db, { actorUserId: redeemed.user_id, actor: 'user', kind: loginEvent, subjectType: 'user', subjectId: redeemed.user_id });
    return res.json({ user: publicUser(redeemed), sessionToken: token });
  });
  r.post('/google/native/exchange', exchangeNativeCode('auth.google_native_login'));
  r.post('/microsoft/native/exchange', exchangeNativeCode('auth.microsoft_native_login'));
  r.post('/native/exchange', exchangeNativeCode('auth.native_login'));

  r.post('/apple/native/exchange', asyncRoute(async (req, res) => {
    if (!isNativeClient(req)) return res.status(403).json({ error: 'native client required' });
    if (!ctx.appleNativeClientId) return res.status(503).json({ error: 'Sign in with Apple is not configured.' });
    const identityToken = typeof req.body?.identityToken === 'string' ? req.body.identityToken : '';
    const nonce = typeof req.body?.nonce === 'string' ? req.body.nonce : '';
    const appleUser = typeof req.body?.appleUser === 'string' ? req.body.appleUser : '';
    if (!identityToken || identityToken.length > 16_384 || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) {
      return res.status(400).json({ error: 'invalid Apple credential' });
    }
    let identity;
    try {
      identity = await verifyAppleIdentityToken({
        token: identityToken,
        nonce,
        clientId: ctx.appleNativeClientId,
        fetchImpl: ctx.appleFetch,
      });
    } catch {
      return res.status(401).json({ error: 'Apple could not verify this sign-in.' });
    }
    if (appleUser && appleUser !== identity.subject) {
      return res.status(401).json({ error: 'Apple could not verify this sign-in.' });
    }

    const [user] = await db.query<{
      id: string; email: string; username: string; role: string; display_name: string | null; mfa_enabled_at: string | null;
    }>(
      `select u.id,u.email,u.username,u.role,u.display_name,u.mfa_enabled_at
       from auth_identities i join users u on u.id=i.user_id
       where i.provider='apple' and i.provider_subject=$1 and u.status='active'`,
      [identity.subject],
    );
    if (!user || user.mfa_enabled_at) {
      const challenge = randomBytes(32).toString('base64url');
      await db.query(
        `insert into auth_apple_challenges
           (challenge_hash,purpose,provider_subject,verified_email,private_relay,user_id,expires_at)
         values($1,$2,$3,$4,$5,$6,now()+interval '5 minutes')`,
        [createHash('sha256').update(challenge).digest('hex'), user ? 'mfa_login' : 'link',
          identity.subject, identity.email, identity.privateRelay, user?.id ?? null],
      );
      return res.status(202).json(user
        ? { mfaRequired: true, challenge }
        : { linkRequired: true, challenge });
    }

    await db.query(
      `update auth_identities set verified_email=coalesce($2,verified_email),private_relay=$3,last_login_at=now()
       where provider='apple' and provider_subject=$1`,
      [identity.subject, identity.email, identity.privateRelay],
    );
    const { token } = await createSession(db, {
      userId: user.id, ip: clientIp(req), userAgent: req.header('user-agent'), ttlSeconds: SESSION_TTL_SECONDS,
    });
    await appendEvent(db, {
      actorUserId: user.id, actor: 'user', kind: 'auth.apple_native_login', subjectType: 'user', subjectId: user.id,
      payload: { privateRelay: identity.privateRelay },
    });
    return res.json({ user: publicUser(user), sessionToken: token });
  }));

  r.post('/apple/native/complete', mfaRoute(async (req, res) => {
    if (!isNativeClient(req)) return res.status(403).json({ error: 'native client required' });
    const challenge = typeof req.body?.challenge === 'string' ? req.body.challenge : '';
    const identifier = typeof req.body?.identifier === 'string' ? req.body.identifier.trim() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const mfaCode = typeof req.body?.mfaCode === 'string' ? req.body.mfaCode.replace(/\s/g, '') : '';
    const [pending] = await db.query<{
      purpose: 'link' | 'mfa_login'; provider_subject: string; verified_email: string | null;
      private_relay: boolean; user_id: string | null;
    }>(
      `select purpose,provider_subject,verified_email,private_relay,user_id
       from auth_apple_challenges where challenge_hash=$1 and used_at is null and expires_at>now() and attempts<5`,
      [createHash('sha256').update(challenge).digest('hex')],
    );
    if (!pending) return res.status(401).json({ error: 'That Apple sign-in expired. Start again.' });

    let userId = pending.user_id;
    if (pending.purpose === 'link') {
      if (!identifier || !password) return res.status(400).json({ error: 'Enter your existing workspace credentials to link Apple.' });
      const result = await login(db, { identifier, password, ip: clientIp(req) });
      if (!result.ok) {
        if (result.reason === 'rate_limited') {
          res.set('Retry-After', String(result.verdict.retryAfterSeconds));
          return res.status(429).json({ error: 'too many attempts, try again later' });
        }
        return res.status(401).json({ error: 'wrong username or password' });
      }
      userId = result.user.id;
    }
    if (!userId) return res.status(401).json({ error: 'That Apple sign-in expired. Start again.' });

    const [account] = await db.query<{ totp_secret_enc: string | null; mfa_enabled_at: string | null }>(
      `select totp_secret_enc,mfa_enabled_at from users where id=$1 and status='active'`, [userId],
    );
    if (!account) return res.status(401).json({ error: 'That Apple sign-in expired. Start again.' });
    if (account.mfa_enabled_at) {
      if (!mfaCode) return res.status(202).json({ mfaRequired: true, challenge });
      if (!(await verifyMfaFactor(db, mfaKey(), userId, mfaCode))) {
        await db.query(`update auth_apple_challenges set attempts=least(attempts+1,5) where challenge_hash=$1`, [
          createHash('sha256').update(challenge).digest('hex'),
        ]);
        return res.status(401).json({ error: 'That verification code did not work.' });
      }
    }

    const claimed = await db.query<{ provider_subject: string }>(
      `update auth_apple_challenges set used_at=now()
       where challenge_hash=$1 and used_at is null and expires_at>now() returning provider_subject`,
      [createHash('sha256').update(challenge).digest('hex')],
    );
    if (!claimed[0]) return res.status(401).json({ error: 'That Apple sign-in expired. Start again.' });
    if (pending.purpose === 'link') {
      const linked = await db.query<{ user_id: string }>(
        `insert into auth_identities(user_id,provider,provider_subject,verified_email,private_relay)
         values($1,'apple',$2,$3,$4) on conflict do nothing returning user_id`,
        [userId, pending.provider_subject, pending.verified_email, pending.private_relay],
      );
      if (!linked[0]) return res.status(409).json({ error: 'Apple is already linked to another workspace account.' });
      await appendEvent(db, { actorUserId: userId, actor: 'user', kind: 'auth.apple_linked', subjectType: 'user', subjectId: userId });
    }
    const [user] = await db.query<{
      id: string; email: string; username: string; role: string; display_name: string | null;
    }>(`select id,email,username,role,display_name from users where id=$1 and status='active'`, [userId]);
    if (!user) return res.status(401).json({ error: 'That Apple sign-in expired. Start again.' });
    const { token } = await createSession(db, {
      userId, ip: clientIp(req), userAgent: req.header('user-agent'), ttlSeconds: SESSION_TTL_SECONDS,
    });
    await appendEvent(db, { actorUserId: userId, actor: 'user', kind: 'auth.apple_native_login', subjectType: 'user', subjectId: userId });
    return res.json({ user: publicUser(user), sessionToken: token });
  }));

  r.get('/me', requireAuth, (req, res) => {
    res.json({ user: publicUser(req.user!) });
  });

  /** Render-side check for the set-password form. Reveals only the username the
   * token already belongs to, and a masked address. */
  // Native clients send the token in a body so it need not appear in request
  // paths or URL history. The existing GET remains for older remote clients.
  r.post('/token/inspect', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    const token = req.body?.token;
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      return res.status(400).json({ error: 'use an exact invitation or reset token' });
    }
    const found = await peekAuthToken(db, token);
    if (!found) return res.status(404).json({ error: 'that link is expired or already used' });
    return res.json({ purpose: found.purpose, username: found.username, email: maskEmail(found.email) });
  }));
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

      // Native recovery returns to normal login, including its authenticator.
      // Existing web/remote clients retain their established response shape.
      if (req.body?.signIn === false) {
        clearSessionCookie(res);
        res.set('Cache-Control', 'private, no-store');
        return res.json({ ok: true, passwordChanged: true });
      }

      // The link proves the mailbox, not the authenticator. The password stays
      // changed, but a session still has to get past the second factor.
      const [mfa] = await db.query<{ mfa_enabled_at: string | null }>(
        `select mfa_enabled_at from users where id = $1`, [redeemed.user_id],
      );
      if (mfa?.mfa_enabled_at) {
        clearSessionCookie(res);
        res.set('Cache-Control', 'private, no-store');
        const challenge = await issueMfaChallenge(req, redeemed.user_id, true);
        setMfaChallengeCookie(res, challenge, cookieOpts(req));
        return res.status(202).json({ mfaRequired: true, challenge });
      }

      // setPassword revoked every session, so the token they just burned is the
      // only proof of identity available. Sign them in with a fresh one.
      const { token: sessionToken } = await createSession(db, {
        userId: redeemed.user_id,
        ip: clientIp(req),
        userAgent: req.header('user-agent'),
      });
      setSessionCookie(res, sessionToken, SESSION_TTL_SECONDS, cookieOpts(req));
      issueCsrfToken(res, cookieOpts(req));
      const rows = await db.query<{
        id: string; email: string; username: string; role: 'super_admin' | 'member'; display_name: string | null;
      }>(`select id, email, username, role, display_name from users where id = $1`, [redeemed.user_id]);
      return res.json({ user: rows[0] });
    }),
  );

  return r;
}

function publicUser(u: {
  id: string; email: string; username: string; role: string; display_name?: string | null; pc_control_allowed?: boolean;
}) {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    displayName: u.display_name ?? null,
    // The owner is never gated; a member unless the owner switched it off.
    pcControlAllowed: u.role === 'super_admin' || u.pc_control_allowed !== false,
  };
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}${'*'.repeat(Math.max(1, local.length - 2))}@${domain}`;
}
