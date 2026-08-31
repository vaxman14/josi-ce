// The HTTP surface, assembled in one place so the guard order is visible.
//
// Order matters and is deliberate:
//   json body  ->  attachUser  ->  CSRF  ->  routes
// CSRF runs after the session is attached (so a rejection can be audited with a
// user) but before any handler, so no state-changing code path can be reached
// without a matching token.
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { checkReadiness, type Db, type LoadOptions } from '@josi-ce/core';
import { attachUser } from './http/authz.js';
import { requireCsrf } from './http/cookies.js';
import { authRoutes } from './http/authRoutes.js';
import { adminRoutes } from './http/adminRoutes.js';
import { adminConnectionRoutes, connectionRoutes } from './http/connectionRoutes.js';
import { adminConnectorRoutes, connectorRoutes } from './http/connectorRoutes.js';
import { adminMailRoutes, mailRoutes } from './http/mailRoutes.js';
import { adminLlmRoutes, llmRoutes } from './http/llmRoutes.js';
import { adminAssistantRoutes, assistantRoutes } from './http/assistantRoutes.js';
import { setupGate } from './http/setupGate.js';
import { setupRoutes } from './setup/setupRoutes.js';
import { mountWebApp } from './http/staticApp.js';

export interface AppConfig {
  /** https in production; false lets cookies work over plain http locally. */
  cookieSecure: boolean;
  /** Public origin, used for invite/reset links. */
  appUrl: string;
  /** Master-key options for the readiness probe, or `false` to skip the check
   * (tests, and the migration container which runs before a key exists). */
  masterKeyCheck?: LoadOptions | false;
  /** Provider HTTP and DNS, injected by the tests so no suite ever contacts a
   * real model provider. Unset in production, where the real ones are used. */
  llmFetch?: typeof fetch;
  llmResolve?: (hostname: string) => Promise<string[]>;
  /** Provider HTTP for connectors, injected by the tests so no suite ever
   * contacts Google or Microsoft. */
  connectorFetch?: typeof fetch;
  /** SMTP, injected by the tests so no suite ever contacts a mail server. */
  mailTransport?: import('@josi-ce/mail').SmtpTransport;
  /** Directory holding the built web bundle. Absent = API only. */
  webDir?: string;
}

export function createApp(db: Db, cfg: AppConfig): Express {
  const app = express();

  // A request body is the only unbounded input here; 1 MB is generous for JSON
  // and small enough that a hostile client cannot exhaust memory.
  app.use(express.json({ limit: '1mb' }));
  app.disable('x-powered-by');

  // Liveness: is this process up. Deliberately consults nothing — a health
  // check that fails when the database blips gets a healthy process restarted,
  // which makes the outage worse.
  app.get('/health', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ ok: true, service: 'josi-ce' });
  });

  // Readiness: may this instance take traffic. Names coarse subsystems and
  // nothing else — no hostnames, ports, versions, paths or database error text.
  app.get('/ready', (_req, res) => {
    void (async () => {
      const result = await checkReadiness(db, { masterKey: cfg.masterKeyCheck });
      res.set('Cache-Control', 'no-store');
      res.status(result.ready ? 200 : 503).json(result);
    })();
  });

  const api = express.Router();
  api.use(attachUser({ db }));
  api.use(requireCsrf);
  // Before the routes, after CSRF: an unconfigured installation refuses
  // everything except the wizard, and a configured one refuses the wizard.
  api.use(setupGate(db));

  api.use('/setup', setupRoutes({ db, masterKey: cfg.masterKeyCheck }));
  api.use('/auth', authRoutes({ db, cookieSecure: cfg.cookieSecure }));
  // Phase 7 owns /connections now: the Phase 1 router proved the ownership
  // shape against a real table; this one actually connects accounts.
  api.use('/connections', connectorRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch, appUrl: cfg.appUrl,
  }));
  api.use('/llm', llmRoutes({ db, masterKey: cfg.masterKeyCheck }));
  // Mounted before /admin so the more specific prefix wins; both are behind
  // requireSuperAdmin either way.
  api.use('/assistant', assistantRoutes({ db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.llmFetch, resolve: cfg.llmResolve }));
  api.use('/admin/assistant', adminAssistantRoutes({ db }));
  api.use('/admin/llm', adminLlmRoutes({ db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.llmFetch, resolve: cfg.llmResolve }));
  api.use('/admin', adminRoutes({ db, appUrl: cfg.appUrl }));
  api.use('/mail', mailRoutes({ db, masterKey: cfg.masterKeyCheck, transport: cfg.mailTransport }));
  api.use('/admin/mail', adminMailRoutes({ db, masterKey: cfg.masterKeyCheck, transport: cfg.mailTransport }));
  api.use('/admin/connectors', adminConnectorRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch, appUrl: cfg.appUrl,
  }));
  api.use('/admin/connections', adminConnectionRoutes({ db }));

  api.use((_req, res) => res.status(404).json({ error: 'no such endpoint' }));

  // JSON errors for /api, always. An HTML stack trace inside a fetch() is a bug
  // report nobody can read — and a stack trace in a response body is a leak.
  api.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(`api error ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'something broke on our side' });
  });

  app.use('/api', api);

  // Last: the SPA and its security headers. Mounted after /api so an unknown
  // endpoint still answers with the API's JSON 404 rather than an HTML page.
  mountWebApp(app, { dir: cfg.webDir });

  return app;
}
