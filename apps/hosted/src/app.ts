import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { RPC_PATH } from '@josi-ce/tunnel';
import { aiRouter } from './ai/gateway.js';
import { handleWebhook } from './billing.js';
import type { Ctx } from './context.js';
import { HttpError } from './errors.js';
import { googleCallback } from './google.js';
import { finishGoogleLogin, isLoginState, startGoogleLogin } from './googleLogin.js';
import { notice } from './pages.js';
import { answerRpc } from './rpc.js';
import { SESSION_COOKIE, apiRouter, loadSession } from './web.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '../public');
const PAGES: Record<string, string> = { '/signup': 'signup', '/login': 'login', '/verify': 'verify', '/forgot': 'forgot', '/reset': 'reset', '/join': 'join', '/signup/google': 'google-name' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.set({
    'content-security-policy': CSP, 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'strict-transport-security': 'max-age=63072000; includeSubDomains', 'cross-origin-opener-policy': 'same-origin', 'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
}

export function createApp(ctx: Ctx): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);

  app.get('/health', (_req, res) => { res.json({ ok: true }); });
  // A server needs this before its first call. HTTPS vouches for it that once,
  // and the server pins it from then on.
  app.get('/v1/noise-key', (_req, res) => { res.json({ publicKey: ctx.hostedPublic }); });

  app.post(RPC_PATH, express.raw({ type: () => true, limit: '512kb' }), async (req, res) => {
    let reply: Uint8Array;
    try { reply = await answerRpc(ctx, new Uint8Array(req.body as Buffer)); } catch { res.status(400).end(); return; }
    res.status(200).type('application/octet-stream').send(Buffer.from(reply));
  });

  app.post('/stripe/webhook', express.raw({ type: () => true, limit: '1mb' }), async (req, res) => {
    await handleWebhook(ctx, req.body as Buffer, req.get('stripe-signature'));
    res.json({ received: true });
  });

  app.use('/ai/v1', aiRouter(ctx));
  app.get('/auth/google', (req, res) => startGoogleLogin(ctx, req, res));
  app.get('/oauth/google/callback', (req, res) => isLoginState(req.query.state) ? finishGoogleLogin(ctx, req, res) : googleCallback(ctx, req, res));
  app.use('/api', apiRouter(ctx));

  const sendPage = (res: Response, name: string) => res.set('cache-control', 'no-store').sendFile(join(PUBLIC, `${name}.html`));
  for (const [path, name] of Object.entries(PAGES)) app.get(path, (_req, res) => sendPage(res, name));
  app.get('/account', loadSession(ctx), (req: Request & { session?: unknown }, res) => { if (req.session) sendPage(res, 'account'); else res.redirect(302, '/login'); });
  app.get('/', (req, res) => { res.redirect(302, (req.get('cookie') ?? '').includes(SESSION_COOKIE) ? '/account' : '/login'); });
  app.use(express.static(PUBLIC, { index: false, extensions: false }));
  app.use((req, res) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/ai') || req.path.startsWith('/v1')) res.status(404).json({ error: 'Not found.' });
    else notice(res, 404, 'Nothing here', 'That page doesn\'t exist.');
  });

  // Never the error itself: a message can quote what it failed on.
  app.use((error: Error & { status?: number; code?: string }, req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) { res.destroy(); return; }
    const ai = req.path.startsWith('/ai/');
    if (error instanceof HttpError) { res.status(error.status).json(ai ? { error: { type: 'invalid_request_error', code: error.code ?? 'error', message: error.message } } : { error: error.message, code: error.code }); return; }
    if (error.status && error.status < 500) {
      const message = error.status === 413 ? 'That request is too large.' : 'That request couldn\'t be read.';
      res.status(error.status).json(ai ? { error: { type: 'invalid_request_error', code: 'bad_request', message } } : { error: message });
      return;
    }
    ctx.log('request_failed', { path: req.path.startsWith('/oauth') ? '/oauth' : req.path, kind: error.name });
    res.status(500).json(ai ? { error: { type: 'server_error', code: 'josi_internal', message: 'Something went wrong here. Try again in a moment.' } } : { error: 'Something went wrong. Try again in a minute.' });
  });
  return app;
}
