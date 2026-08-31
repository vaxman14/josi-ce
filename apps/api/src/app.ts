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

export interface AppConfig {
  /** https in production; false lets cookies work over plain http locally. */
  cookieSecure: boolean;
  /** Public origin, used for invite/reset links. */
  appUrl: string;
  /** Master-key options for the readiness probe, or `false` to skip the check
   * (tests, and the migration container which runs before a key exists). */
  masterKeyCheck?: LoadOptions | false;
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

  api.use('/auth', authRoutes({ db, cookieSecure: cfg.cookieSecure }));
  api.use('/connections', connectionRoutes({ db }));
  api.use('/admin', adminRoutes({ db, appUrl: cfg.appUrl }));
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
  return app;
}
