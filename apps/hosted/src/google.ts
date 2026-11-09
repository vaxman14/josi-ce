// The Google broker. One shared OAuth client, whose secret only this service
// holds, so a person's server can use "Sign in with Google" without Google ever
// knowing it exists.
//
// Tokens only pass through here on their way to the person's server. This file
// must never write a code, a verifier or a token to the database or the log, and
// a test scans both after a full flow.
import type { Request, Response } from 'express';
import type { HostedCall } from '@josi-ce/tunnel';
import { TunnelError } from '@josi-ce/tunnel';
import type { Ctx } from './context.js';
import { hmacHex, safeEqual } from './crypto.js';
import { notice } from './pages.js';
import { askServer, isOffline } from './peer.js';
import { planOf } from './plans.js';
import type { ServerRow } from './rpc.js';

export const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const STATE_TTL_MS = 10 * 60_000;
export const API = 'https://www.googleapis.com/auth/';

export const ALLOWED_SCOPES = new Set(['openid', `${API}userinfo.email`, `${API}gmail.readonly`, `${API}gmail.send`, `${API}calendar.readonly`, `${API}calendar`,
  `${API}contacts.readonly`, `${API}contacts`, `${API}drive.readonly`]);

const BAD_SCOPE = { ok: false, error: 'bad_scope', message: 'One of those Google permissions isn\'t allowed here.' };
const PLAN_REQUIRED = { ok: false, error: 'plan_required', message: 'Hey Josi Google sign-in needs the Connect plan or above.' };

function parseScopes(scopes: unknown): string[] | null {
  const list = [...new Set(String(scopes ?? '').split(/\s+/).filter(Boolean))];
  return list.length && list.every(scope => ALLOWED_SCOPES.has(scope)) ? list : null;
}

export function wrapState(ctx: Ctx, serverId: string, state: string): string {
  const body = Buffer.from(JSON.stringify({ s: serverId, t: state, e: ctx.now() + STATE_TTL_MS })).toString('base64url');
  return `${body}.${hmacHex(ctx.oauthKey, body)}`;
}

export function unwrapState(ctx: Ctx, wrapped: unknown): { serverId: string; state: string } | null {
  const [body, signature, extra] = String(wrapped ?? '').split('.');
  if (!body || !signature || extra !== undefined || !safeEqual(signature, hmacHex(ctx.oauthKey, body))) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { s: string; t: string; e: number };
    return claims.e > ctx.now() ? { serverId: claims.s, state: claims.t } : null;
  } catch { return null; }
}

export async function googleAuthorize(ctx: Ctx, server: ServerRow, call: Extract<HostedCall, { op: 'google.authorize' }>): Promise<Record<string, unknown>> {
  if ((await planOf(ctx, server.account_id)).plan === 'free') return PLAN_REQUIRED;
  const scopes = parseScopes(call.scopes);
  if (!scopes) return BAD_SCOPE;
  const state = String(call.state ?? ''), challenge = String(call.codeChallenge ?? '');
  if (!state || state.length > 512 || !/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return { ok: false, error: 'bad_request' };
  const params = new URLSearchParams({
    client_id: ctx.config.google.clientId, redirect_uri: ctx.config.google.redirectUri, response_type: 'code', scope: scopes.join(' '),
    state: wrapState(ctx, server.id, state), code_challenge: challenge, code_challenge_method: 'S256',
    access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true',
  });
  return { ok: true, url: `${AUTH_URL}?${params}` };
}

interface TokenReply { id_token?: string; access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }

export async function tokenCall(ctx: Ctx, params: Record<string, string>): Promise<{ status: number; body: TokenReply }> {
  const res = await ctx.fetch(TOKEN_URL, {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: ctx.config.google.clientId, client_secret: ctx.config.google.clientSecret, ...params }).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as TokenReply };
}

/** Stateless: the refresh token arrives, the access token leaves. */
export async function googleRefresh(ctx: Ctx, server: ServerRow, call: Extract<HostedCall, { op: 'google.refresh' }>): Promise<Record<string, unknown>> {
  if ((await planOf(ctx, server.account_id)).plan === 'free') return PLAN_REQUIRED;
  if (call.scopes && !parseScopes(call.scopes)) return BAD_SCOPE;
  if (typeof call.refreshToken !== 'string' || !call.refreshToken) return { ok: false, error: 'bad_request' };
  let reply;
  try { reply = await tokenCall(ctx, { grant_type: 'refresh_token', refresh_token: call.refreshToken }); } catch { return { ok: false, error: 'google_unavailable' }; }
  if (reply.body.error === 'invalid_grant') return { ok: false, error: 'invalid_grant' };
  if (!reply.body.access_token) { ctx.log('google_refresh_refused', { status: reply.status }); return { ok: false, error: 'google_error' }; }
  return { ok: true, accessToken: reply.body.access_token, expiresIn: reply.body.expires_in ?? null, scope: reply.body.scope ?? call.scopes };
}

/** A path on the person's own address, and nothing that could leave it. */
function safePath(path: unknown): string {
  const value = typeof path === 'string' ? path : '/';
  return value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') && !/[\r\n]/.test(value) ? value : '/';
}

const OFFLINE = 'Your Josi server isn\'t connected right now, so nothing was saved. Start it, then connect Google again.';

export async function googleCallback(ctx: Ctx, req: Request, res: Response): Promise<void> {
  const wrapped = unwrapState(ctx, req.query.state);
  if (!wrapped) { notice(res, 400, 'That link has expired', 'Go back to Josi and connect Google again.'); return; }
  const [server] = await ctx.db.query<ServerRow>('select * from heyjosi.servers where id = $1', [wrapped.serverId]);
  if (!server) { notice(res, 400, 'That server isn\'t linked', 'Link your Josi server to your account, then connect Google again.'); return; }
  const home = `https://${server.name}.${ctx.config.domain}`;
  const code = req.query.code;
  if (typeof code !== 'string' || !code) { notice(res, 400, 'Google wasn\'t connected', 'Nothing changed. You can try again from Josi.', home); return; }
  let verifier: unknown;
  try {
    verifier = (await askServer(ctx, server, { v: 1, op: 'google-begin', state: wrapped.state, ts: ctx.now() })).verifier;
  } catch (error) {
    if (isOffline(error)) notice(res, 503, 'Your server is offline', OFFLINE, home);
    else { ctx.log('google_begin_refused', { code: error instanceof TunnelError ? error.code : 'unknown' }); notice(res, 400, 'That link has expired', 'Go back to Josi and connect Google again.', home); }
    return;
  }
  if (typeof verifier !== 'string' || !verifier) { notice(res, 400, 'That link has expired', 'Go back to Josi and connect Google again.', home); return; }

  let tokens: TokenReply;
  try {
    const reply = await tokenCall(ctx, { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: ctx.config.google.redirectUri });
    tokens = reply.body;
    if (!tokens.access_token) { ctx.log('google_exchange_refused', { status: reply.status }); throw new Error('no token'); }
  } catch { notice(res, 502, 'Google said no', 'Google didn\'t accept that sign-in. Go back to Josi and try again.', home); return; }

  try {
    const reply = await askServer(ctx, server, {
      v: 1, op: 'google-tokens', state: wrapped.state, accessToken: tokens.access_token!, refreshToken: tokens.refresh_token ?? null,
      expiresIn: tokens.expires_in ?? null, scope: tokens.scope ?? '', ts: ctx.now(),
    });
    res.redirect(302, `${home}${safePath(reply.returnPath)}`);
  } catch (error) {
    if (isOffline(error)) notice(res, 503, 'Your server is offline', OFFLINE, home);
    else notice(res, 400, 'That link has expired', 'Go back to Josi and connect Google again.', home);
  }
}
