// Signing in without a password: passkeys and emailed codes.
//
// A passkey answers both factors, because the browser is told to require the
// fingerprint, face or PIN and the verifier refuses a response without it. An
// emailed code answers only the first, so an account with an authenticator still
// goes to the MFA step, exactly as it does after a password.
//
// A Mac app cannot run WebAuthn for a self-hosted domain, so it opens the bridge
// below in the system browser. The bridge ends in a one-time code for the app,
// never in a browser session. Adding a passkey works the same way: the app proves
// the password and gets a one-time ticket for the page, which also sets no session.
import { createHash, randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import {
  EMAIL_CODE_RESEND_SECONDS, EMAIL_CODE_TTL_SECONDS, GOOGLE_NATIVE_RETURN_URI, SESSION_TTL_SECONDS, WebAuthnError, beginPasskeyLogin, beginPasskeyRegistration, checkLoginRate, createSession, emailHash,
  finishPasskeyLogin, finishPasskeyRegistration, issuePasskeyTicket, listPasskeys, passkeyLabel, readPasskeyTicket, recordLoginAttempt, relyingParty, removePasskey,
  requestEmailCode, spendPasskeyTicket, verifyEmailCode, verifyPassword, type RelyingParty,
} from '@josi-ce/auth';
import { appendEvent, loadMasterKey, type Db, type LoadOptions } from '@josi-ce/core';
import { loadProfile, smtpTransport, type SmtpTransport } from '@josi-ce/mail';
import { asyncRoute, param } from './async.js';
import { clientIp, cookieSecureFor, isNativeClient, issueCsrfToken, setSessionCookie, type CookieSecurePolicy } from './cookies.js';
import { requireAuth } from './authz.js';
import { issueNativeCode, nativeCallback } from './nativeCodes.js';
import { NATIVE_PASSKEY_ADD_PAGE, NATIVE_PASSKEY_ADD_SCRIPT, NATIVE_PASSKEY_PAGE, NATIVE_PASSKEY_SCRIPT } from './nativePasskeyPage.js';
import { CONTENT_SECURITY_POLICY } from './staticApp.js';

export interface SignInRoutesCtx {
  db: Db;
  cookieSecure: CookieSecurePolicy;
  appUrl: string;
  masterKey?: LoadOptions | false;
  mailTransport?: SmtpTransport;
  passkeysEnabled?: boolean;
  emailCodesEnabled?: boolean;
  /** Set once Sign in with Apple exists on the web. Until then the button is hidden. */
  appleWebSignInUrl?: string | null;
}

const passkeyRoute = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  try { return await fn(req, res); }
  catch (err) {
    if (err instanceof WebAuthnError) return res.status(400).json({ error: err.message });
    throw err;
  }
});

interface Person { id: string; email: string; username: string; role: string; display_name: string | null; mfa_enabled_at: string | null }

type PasskeyProof = { user: Person } | { blockedFor: number } | { refused: true };

/** The app's own value, handed back to it unchanged. It is never written into the
 * page, but it does go into a URL, so it has to be printable and bounded. */
function nativeState(value: unknown): string | null {
  return typeof value === 'string' && /^[\x21-\x7e]{1,512}$/.test(value) ? value : null;
}

export function signInRoutes(ctx: SignInRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  const rp = ctx.passkeysEnabled === false ? null : relyingParty(ctx.appUrl);
  const cookieOpts = (req: Request) => ({ secure: cookieSecureFor(req, ctx.cookieSecure) });

  /** The system mail profile, or null when this install has none. */
  async function systemMail() {
    if (ctx.emailCodesEnabled === false || ctx.masterKey === false) return null;
    try {
      const profile = await loadProfile(db, loadMasterKey(ctx.masterKey ?? {}), 'system');
      return { profile, transport: ctx.mailTransport ?? smtpTransport(profile) };
    } catch { return null; }
  }

  async function person(id: string): Promise<Person | undefined> {
    const [row] = await db.query<Person>(`select id, email, username, role, display_name, mfa_enabled_at from users where id = $1 and status = 'active'`, [id]);
    return row;
  }

  async function signIn(req: Request, res: Response, user: Person, kind: string) {
    const ip = clientIp(req);
    const { token } = await createSession(db, { userId: user.id, ip, userAgent: req.header('user-agent'), ttlSeconds: SESSION_TTL_SECONDS });
    setSessionCookie(res, token, SESSION_TTL_SECONDS, cookieOpts(req));
    issueCsrfToken(res, cookieOpts(req));
    await appendEvent(db, { actorUserId: user.id, actor: 'user', kind, subjectType: 'user', subjectId: user.id, payload: { ip } });
    return res.json({ user: { id: user.id, email: user.email, username: user.username, role: user.role, displayName: user.display_name } });
  }

  /** Spends a passkey response. The browser sign-in and the native bridge share
   * this, so one limit and one failure count cover both. */
  async function provePasskey(req: Request, party: RelyingParty): Promise<PasskeyProof> {
    const ip = clientIp(req), identifier = `passkey:${ip ?? 'unknown'}`;
    const verdict = await checkLoginRate(db, identifier, ip);
    if (verdict.blocked) return { blockedFor: verdict.retryAfterSeconds };
    let userId: string;
    try { userId = await finishPasskeyLogin(db, party, req.body ?? {}); }
    catch (err) {
      await recordLoginAttempt(db, { identifier, ip, success: false });
      if (err instanceof WebAuthnError) return { refused: true };
      throw err;
    }
    const user = await person(userId);
    if (!user) return { refused: true };
    await recordLoginAttempt(db, { identifier, ip, success: true });
    return { user };
  }

  /** Set here because the static app's policy is mounted after the API, so nothing
   * else covers these pages. Their scripts are same-origin files to fit it. */
  function sendBridgePage(res: Response, html: string) {
    res.set({ 'Content-Security-Policy': CONTENT_SECURITY_POLICY, 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    return res.type('html').send(html);
  }

  function sendBridgeScript(res: Response, script: string) {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.type('text/javascript').send(script);
  }

  const tooMany = (res: Response, seconds: number) => { res.set('Retry-After', String(seconds)); return res.status(429).json({ error: 'too many attempts, try again later' }); };

  /** The password check in front of adding a passkey, on one limit however the
   * request arrived. Answers the request itself when it says no. */
  async function passwordAllowsAdding(req: Request, res: Response, userId: string): Promise<boolean> {
    const ip = clientIp(req), identifier = `passkey-add:${userId}`;
    const verdict = await checkLoginRate(db, identifier, ip);
    if (verdict.blocked) { tooMany(res, verdict.retryAfterSeconds); return false; }
    const [row] = await db.query<{ password_hash: string | null }>(`select password_hash from users where id = $1`, [userId]);
    const matched = await verifyPassword(row?.password_hash ?? null, typeof req.body?.password === 'string' ? req.body.password : '');
    await recordLoginAttempt(db, { identifier, ip, success: matched });
    if (!matched) res.status(401).json({ error: 'That password did not match.' });
    return matched;
  }

  /** What the sign-in page offers. Reports only on/off, never why. */
  r.get('/methods', asyncRoute(async (_req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({
      passkey: !!rp,
      passkeyOrigin: rp?.origin ?? null,
      emailCode: !!(await systemMail()),
      appleUrl: ctx.appleWebSignInUrl || null,
    });
  }));

  // --------------------------------------------------------------- email code
  r.post('/email-code/request', asyncRoute(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, 320) : '';
    if (!/^\S+@\S+\.\S+$/.test(email) || /[\u0000-\u001f\u007f]/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
    const mail = await systemMail();
    if (!mail) return res.status(404).json({ error: 'Email sign-in is not available on this server.' });
    const result = await requestEmailCode(db, { email, ip: clientIp(req) });
    if (result.outcome === 'limited') return tooMany(res, 3600);
    if (result.outcome === 'issued' && result.user && result.code) {
      // Not awaited, so a real address takes no longer to answer than an unknown
      // one. A delivery failure stays quiet for the same reason it does on
      // password reset: the answer must not differ.
      const { profile, transport } = mail, { user, code } = result;
      void transport.send({
        from: `${profile.fromName} <${profile.fromAddress}>`, replyTo: profile.fromAddress,
        to: [user.email], cc: [], subject: `${code} is your Josi sign-in code`,
        text: `Your Josi sign-in code is ${code}.\n\nIt works once, for ${EMAIL_CODE_TTL_SECONDS / 60} minutes.\n\nIf you did not ask for it, ignore this message. Nobody can sign in without the code.`,
        headers: { 'Auto-Submitted': 'auto-generated' }, attachments: [],
      }).catch(() => undefined);
    }
    return res.json({ ok: true, message: 'If that email belongs to an account here, a code is on its way.', resendAfterSeconds: EMAIL_CODE_RESEND_SECONDS });
  }));

  r.post('/email-code/verify', asyncRoute(async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().slice(0, 320) : '';
    const code = typeof req.body?.code === 'string' ? req.body.code.replace(/\s/g, '') : '';
    const ip = clientIp(req), identifier = `email-code:${emailHash(email)}`;
    const verdict = await checkLoginRate(db, identifier, ip);
    if (verdict.blocked) return tooMany(res, verdict.retryAfterSeconds);
    const userId = await verifyEmailCode(db, { email, code });
    const user = userId ? await person(userId) : undefined;
    await recordLoginAttempt(db, { identifier, ip, success: !!user });
    if (!user) return res.status(401).json({ error: 'That code did not work. Check it, or send a new one.' });
    if (user.mfa_enabled_at) {
      const challenge = randomBytes(32).toString('base64url');
      await db.query(
        `insert into auth_mfa_challenges (user_id, token_hash, remember_me, ip, user_agent, expires_at)
         values ($1, $2, true, $3, $4, now() + interval '5 minutes')`,
        [user.id, createHash('sha256').update(challenge).digest('hex'), ip, req.header('user-agent')?.slice(0, 400) ?? null],
      );
      return res.status(202).json({ mfaRequired: true, challenge });
    }
    return signIn(req, res, user, 'auth.email_code_login');
  }));

  // ------------------------------------------------------------------ passkey
  r.post('/passkey/options', passkeyRoute(async (req, res) => {
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    return res.json({ options: await beginPasskeyLogin(db, rp, clientIp(req)) });
  }));

  r.post('/passkey/verify', passkeyRoute(async (req, res) => {
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    const proof = await provePasskey(req, rp);
    if ('blockedFor' in proof) return tooMany(res, proof.blockedFor);
    if ('refused' in proof) return res.status(401).json({ error: 'That passkey did not work here.' });
    return signIn(req, res, proof.user, 'auth.passkey_login');
  }));

  // ------------------------------------------------- passkey, for a native app
  // The page uses /passkey/options like any browser, then finishes below. A
  // passkey belongs to APP_URL's origin, which is why /native/config points the
  // app there and not at whatever address it reached this server on.
  r.get('/passkey/native/start', (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.query.redirect_uri !== GOOGLE_NATIVE_RETURN_URI) return res.status(400).json({ error: 'unsupported native redirect URI' });
    const state = nativeState(req.query.state);
    if (state === null) return res.status(400).json({ error: 'state required' });
    if (!rp) return res.redirect(nativeCallback(GOOGLE_NATIVE_RETURN_URI, { error: 'passkey_failed', state }));
    return sendBridgePage(res, NATIVE_PASSKEY_PAGE);
  });

  r.get('/passkey/native/page.js', (_req, res) => sendBridgeScript(res, NATIVE_PASSKEY_SCRIPT));

  /** Always answers with where the page goes next, success or not. The target is
   * fixed here and never taken from the request. */
  r.post('/passkey/native/verify', passkeyRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    const state = nativeState(req.body?.state);
    if (state === null) return res.status(400).json({ error: 'state required' });
    const proof = await provePasskey(req, rp);
    const failed = nativeCallback(GOOGLE_NATIVE_RETURN_URI, { error: 'passkey_failed', state });
    if ('blockedFor' in proof) {
      res.set('Retry-After', String(proof.blockedFor));
      return res.status(429).json({ error: 'too many attempts, try again later', redirect: failed });
    }
    if ('refused' in proof) return res.status(401).json({ error: 'That passkey did not work here.', redirect: failed });
    const code = await issueNativeCode(db, proof.user.id, 'auth.passkey_native_code_issued', true);
    return res.json({ redirect: nativeCallback(GOOGLE_NATIVE_RETURN_URI, { code, state }) });
  }));

  // ------------------------------------------- adding a passkey, for a native app
  const addFailed = (state: string) => nativeCallback(GOOGLE_NATIVE_RETURN_URI, { error: 'passkey_failed', state });
  const ticketIn = (value: unknown) => (typeof value === 'string' ? value : '');

  r.post('/passkey/native/enrol', requireAuth, passkeyRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!isNativeClient(req)) return res.status(403).json({ error: 'native client required' });
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    const state = nativeState(req.body?.state), name = passkeyLabel(req.body?.name);
    if (state === null) return res.status(400).json({ error: 'state required' });
    if (name === null) return res.status(400).json({ error: 'Give this passkey a name.' });
    const user = req.user!;
    if (!await passwordAllowsAdding(req, res, user.id)) return;
    const ticket = await issuePasskeyTicket(db, { userId: user.id, name, state, ip: clientIp(req) });
    const query = new URLSearchParams({ ticket, state });
    return res.json({ url: `${ctx.appUrl.replace(/\/$/, '')}/api/auth/passkey/native/add?${query}` });
  }));

  /** Wrong, expired and used tickets all get the same answer. Opening the page
   * spends nothing; only finishing does. */
  r.get('/passkey/native/add', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const state = nativeState(req.query.state);
    if (state === null) return res.status(400).json({ error: 'state required' });
    if (!rp || !await readPasskeyTicket(db, ticketIn(req.query.ticket), state)) return res.redirect(addFailed(state));
    return sendBridgePage(res, NATIVE_PASSKEY_ADD_PAGE);
  }));

  r.get('/passkey/native/add.js', (_req, res) => sendBridgeScript(res, NATIVE_PASSKEY_ADD_SCRIPT));

  r.post('/passkey/native/add/options', passkeyRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    const state = nativeState(req.body?.state);
    if (state === null) return res.status(400).json({ error: 'state required' });
    const held = await readPasskeyTicket(db, ticketIn(req.body?.ticket), state);
    const user = held ? await person(held.userId) : undefined;
    if (!user) return res.status(401).json({ error: 'That link did not work.', redirect: addFailed(state) });
    return res.json({ options: await beginPasskeyRegistration(db, rp, user, clientIp(req)) });
  }));

  /** The ticket goes first, so a response that fails to verify has still used it. */
  r.post('/passkey/native/add/finish', asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    const state = nativeState(req.body?.state);
    if (state === null) return res.status(400).json({ error: 'state required' });
    const held = await spendPasskeyTicket(db, ticketIn(req.body?.ticket), state);
    if (!held) return res.status(401).json({ error: 'That link did not work.', redirect: addFailed(state) });
    try {
      await finishPasskeyRegistration(db, rp, held.userId, {
        clientDataJSON: req.body?.clientDataJSON, attestationObject: req.body?.attestationObject, transports: req.body?.transports, name: held.name,
      });
    } catch (err) {
      if (err instanceof WebAuthnError) return res.status(400).json({ error: err.message, redirect: addFailed(state) });
      throw err;
    }
    return res.json({ redirect: nativeCallback(GOOGLE_NATIVE_RETURN_URI, { added: '1', state }) });
  }));

  r.get('/passkeys', requireAuth, asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.json({ available: !!rp, origin: rp?.origin ?? null, passkeys: await listPasskeys(db, req.user!.id) });
  }));

  /** A new passkey skips the authenticator at sign-in, so an open session alone
   * must not be able to add one. The password is asked for here, as it is to
   * turn MFA off. */
  r.post('/passkeys/options', requireAuth, passkeyRoute(async (req, res) => {
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    const user = req.user!;
    if (!await passwordAllowsAdding(req, res, user.id)) return;
    return res.json({ options: await beginPasskeyRegistration(db, rp, user, clientIp(req)) });
  }));

  r.post('/passkeys', requireAuth, passkeyRoute(async (req, res) => {
    if (!rp) return res.status(404).json({ error: 'Passkeys are not available on this server.' });
    return res.json({ passkey: await finishPasskeyRegistration(db, rp, req.user!.id, req.body ?? {}) });
  }));

  r.delete('/passkeys/:id', requireAuth, asyncRoute(async (req, res) => {
    const id = param(req, 'id');
    if (!/^[0-9a-f-]{36}$/i.test(id) || !await removePasskey(db, req.user!.id, id)) return res.status(404).json({ error: 'That passkey is already gone.' });
    return res.json({ ok: true });
  }));

  return r;
}
