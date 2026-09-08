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
import { checklistRoutes } from './http/checklistRoutes.js';
import { adminConnectionRoutes, connectionRoutes } from './http/connectionRoutes.js';
import { adminDevServiceRoutes, devServiceRoutes } from './http/devServiceRoutes.js';
import { adminCustomApiRoutes, customApiRoutes } from './http/customApiRoutes.js';
import { adminMcpRoutes, mcpRoutes } from './http/mcpRoutes.js';
import { contactSyncRoutes } from './http/contactSyncRoutes.js';
import { adminConnectorRoutes, connectorRoutes } from './http/connectorRoutes.js';
import { adminMailRoutes, mailRoutes } from './http/mailRoutes.js';
import { storageRoutes } from './http/storageRoutes.js';
import { opsRoutes } from './http/opsRoutes.js';
import { personaRoutes } from './http/personaRoutes.js';
import { adminLlmRoutes, llmRoutes } from './http/llmRoutes.js';
import { adminAssistantRoutes, assistantRoutes } from './http/assistantRoutes.js';
import { adminTelegramRoutes, mountTelegramWebhook, telegramRoutes } from './http/telegramRoutes.js';
import { adminExternalChannelRoutes, externalChannelRoutes, mountExternalChannelWebhooks } from './http/externalChannelRoutes.js';
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
  /** How a subscription provider's local binary is run, injected by the tests
   * so no suite ever executes a program. Unset in production. */
  codexRunner?: import('@josi-ce/llm').SpawnRunner;
  /** Telegram Bot API HTTP, injected by the tests so no suite ever contacts
   * api.telegram.org. Unset in production. */
  telegramFetch?: typeof fetch;
  /** Retry timing for outbound Telegram sends. Tests shorten it so a backoff
   * assertion does not spend thirty seconds asleep. */
  telegramRetry?: import('@josi-ce/channels').RetryOptions;
  /** Directory holding the built web bundle. Absent = API only. */
  webDir?: string;
  /** How backups are written. Absent = backups unavailable, which is honest on
   * an installation with no volume for them rather than failing at write time. */
  backupWriter?: import('@josi-ce/ops').BackupWriter;
  /** How a backup is applied. */
  restoreReader?: import('@josi-ce/ops').RestoreReader;
  /** Telemetry transport. Absent = nothing can be sent, whatever the setting. */
  telemetrySender?: import('@josi-ce/ops').TelemetrySender;
  /** M115: unset by default. CE ships no gateway URL and no credential. */
  supportGatewayUrl?: string | null;
  fetchLatestVersion?: () => Promise<string | null>;
  /** DNS for outbound admin-supplied URLs, injected by the tests. */
  outboundResolve?: (hostname: string) => Promise<string[]>;
  /** GitHub/Netlify/Vercel/Supabase HTTP, injected by the tests so no suite
   * contacts a developer service. Unset in production. */
  devServiceFetch?: typeof fetch;
  /** HTTP for administrator-defined custom APIs, injected by the tests so no
   * suite contacts one. Deliberately its own seam rather than reusing
   * `connectorFetch`: that one answers as Google and Microsoft, and a suite
   * that had to satisfy both in one stub would be asserting less about each. */
  customApiFetch?: typeof fetch;
  /** HTTP for external MCP servers, injected by the tests so no suite contacts
   * one. Its own seam again: an MCP stub speaks JSON-RPC over a single POST and
   * a suite that had to satisfy it and a REST API in one stub would be
   * asserting less about each. */
  mcpFetch?: typeof fetch;
}

export function createApp(db: Db, cfg: AppConfig): Express {
  const app = express();

  // A request body is the only unbounded input here; 1 MB is generous for JSON
  // and small enough that a hostile client cannot exhaust memory.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { (req as Request).rawBody = Buffer.from(buf); } }));
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

  // The Telegram webhook, mounted on the ROOT and before `/api`.
  //
  // Outside the API router on purpose: `requireCsrf` and the setup gate both
  // live there, and neither can apply to a caller that has no session and is
  // not a browser. Putting it here means it needs no exemption from either —
  // and an exemption is a hole a later route copies by accident. It
  // authenticates on Telegram's secret-token header instead, in constant time,
  // and answers 404 to everything that fails.
  mountTelegramWebhook(app, {
    db,
    masterKey: cfg.masterKeyCheck,
    fetchImpl: cfg.telegramFetch,
    appUrl: cfg.appUrl,
    llmFetch: cfg.llmFetch,
    llmResolve: cfg.llmResolve,
    connectorFetch: cfg.connectorFetch,
    retry: cfg.telegramRetry,
  });
  mountExternalChannelWebhooks(app, {
    db, masterKey: cfg.masterKeyCheck, appUrl: cfg.appUrl, fetchImpl: cfg.connectorFetch,
    llmFetch: cfg.llmFetch, llmResolve: cfg.llmResolve, connectorFetch: cfg.connectorFetch,
  });

  const api = express.Router();
  api.use(attachUser({ db }));
  api.use(requireCsrf);
  // Before the routes, after CSRF: an unconfigured installation refuses
  // everything except the wizard, and a configured one refuses the wizard.
  api.use(setupGate(db));

  api.use('/setup', setupRoutes({
    db,
    masterKey: cfg.masterKeyCheck,
    // The wizard now contacts what it configures, so it needs the same seams
    // every other subsystem already had.
    llmFetch: cfg.llmFetch,
    llmResolve: cfg.llmResolve,
    connectorFetch: cfg.connectorFetch,
    mailTransport: cfg.mailTransport,
  }));
  api.use('/auth', authRoutes({
    db, cookieSecure: cfg.cookieSecure, appUrl: cfg.appUrl,
    masterKey: cfg.masterKeyCheck, mailTransport: cfg.mailTransport, connectorFetch: cfg.connectorFetch,
  }));
  // Phase 7 owns /connections now: the Phase 1 router proved the ownership
  // shape against a real table; this one actually connects accounts.
  api.use('/connections', connectorRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch, appUrl: cfg.appUrl,
  }));
  // Contact sync sits under /contacts, beside the assistant's own contact
  // routes. Every route in it resolves ownership from the origin rather than
  // from the request, and there is no administrator equivalent: an admin who
  // could start somebody's contact sync could read their address book.
  api.use('/contacts', contactSyncRoutes({
    db, masterKey: cfg.masterKeyCheck, connectorFetch: cfg.connectorFetch,
  }));
  api.use('/llm', llmRoutes({ db, masterKey: cfg.masterKeyCheck, codexRunner: cfg.codexRunner }));
  // Mounted before /admin so the more specific prefix wins; both are behind
  // requireSuperAdmin either way.
  api.use('/assistant', assistantRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.llmFetch, resolve: cfg.llmResolve,
    codexRunner: cfg.codexRunner, connectorFetch: cfg.connectorFetch,
    customApiFetch: cfg.customApiFetch, mcpFetch: cfg.mcpFetch,
    outboundResolve: cfg.outboundResolve,
  }));
  api.use('/admin/assistant', adminAssistantRoutes({ db }));
  api.use('/admin/llm', adminLlmRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.llmFetch, resolve: cfg.llmResolve,
    codexRunner: cfg.codexRunner,
  }));
  // BEFORE `/admin`, with the other specific prefixes.
  //
  // Mount order was wrong here and a mutation found it: with `/admin/telegram`
  // registered after `/admin`, a member's request was refused by adminRoutes'
  // own `requireSuperAdmin` and never reached this router at all. The RBAC test
  // passed — for the wrong reason — and removing THIS router's guard changed
  // nothing observable. The protection was real but it was mount order, and
  // mount order is not where an access-control decision should live.
  api.use('/admin/telegram', adminTelegramRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.telegramFetch, appUrl: cfg.appUrl,
  }));
  api.use('/admin/channels', adminExternalChannelRoutes({
    db, masterKey: cfg.masterKeyCheck, appUrl: cfg.appUrl, fetchImpl: cfg.connectorFetch,
    llmFetch: cfg.llmFetch, llmResolve: cfg.llmResolve, connectorFetch: cfg.connectorFetch,
  }));
  // Developer services. BEFORE `/admin` for the reason recorded above
  // `/admin/telegram`: with the generic admin router registered first, this one
  // is never reached and its own guard stops being the thing protecting it.
  api.use('/admin/developer-services', adminDevServiceRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.devServiceFetch, resolve: cfg.outboundResolve,
  }));
  // Custom APIs. BEFORE `/admin` for the reason recorded above
  // `/admin/telegram`: with the generic admin router registered first, this one
  // is never reached and its own guard stops being the thing protecting it.
  api.use('/admin/custom-apis', adminCustomApiRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.customApiFetch, resolve: cfg.outboundResolve,
  }));
  // External MCP servers. BEFORE `/admin` for the reason recorded above
  // `/admin/telegram`: with the generic admin router registered first, this one
  // is never reached and its own guard stops being the thing protecting it.
  api.use('/admin/mcp-servers', adminMcpRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.mcpFetch, resolve: cfg.outboundResolve,
  }));
  api.use('/admin', adminRoutes({ db, appUrl: cfg.appUrl }));
  // Same mount point, so the super-admin guard above covers it too.
  api.use('/admin', checklistRoutes(db));
  api.use('/mail', mailRoutes({ db, masterKey: cfg.masterKeyCheck, transport: cfg.mailTransport }));
  api.use('/admin/mail', adminMailRoutes({ db, masterKey: cfg.masterKeyCheck, transport: cfg.mailTransport }));
  api.use('/admin/connectors', adminConnectorRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.connectorFetch, appUrl: cfg.appUrl,
  }));
  api.use('/admin/connections', adminConnectionRoutes({ db }));
  // GitHub, Netlify, Vercel and Supabase. Its own prefix rather than a branch
  // inside /connections: these are pasted personal access tokens with no OAuth
  // handshake, no scope vocabulary and no refresh, and folding them into the
  // connector routes would mean one router with two credential models in it.
  api.use('/developer-services', devServiceRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.devServiceFetch, resolve: cfg.outboundResolve,
  }));
  // Administrator-defined external APIs. Its own prefix rather than a branch
  // inside /connections or /developer-services: this is the only connection
  // kind where the ASSISTANT chooses which request to make, and folding it in
  // beside an OAuth grant or a pasted token would present three different
  // authority models as one thing.
  api.use('/custom-apis', customApiRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.customApiFetch, resolve: cfg.outboundResolve,
  }));
  // External MCP servers. Its own prefix rather than a branch inside any of the
  // three above: this is the only connection kind where the far end SPEAKS A
  // PROTOCOL and describes its own tools, so the allowlist is discovered rather
  // than typed — and presenting a discovered allowlist beside a hand-written
  // one would teach people that somebody here reviewed both.
  api.use('/mcp-servers', mcpRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.mcpFetch, resolve: cfg.outboundResolve,
  }));
  api.use('/storage', storageRoutes({ db }));
  api.use('/telegram', telegramRoutes({
    db, masterKey: cfg.masterKeyCheck, fetchImpl: cfg.telegramFetch, appUrl: cfg.appUrl,
  }));
  api.use('/channels', externalChannelRoutes({
    db, masterKey: cfg.masterKeyCheck, appUrl: cfg.appUrl, fetchImpl: cfg.connectorFetch,
    llmFetch: cfg.llmFetch, llmResolve: cfg.llmResolve, connectorFetch: cfg.connectorFetch,
  }));
  api.use('/persona', personaRoutes({
    db,
    masterKey: cfg.masterKeyCheck,
    fetchImpl: cfg.llmFetch,
    resolve: cfg.llmResolve,
  }));
  api.use('/ops', opsRoutes({
    db,
    backupWriter: cfg.backupWriter,
    restoreReader: cfg.restoreReader,
    telemetrySender: cfg.telemetrySender,
    supportGatewayUrl: cfg.supportGatewayUrl ?? null,
    fetchLatestVersion: cfg.fetchLatestVersion,
    outboundResolve: cfg.outboundResolve,
  }));

  api.use((_req, res) => res.status(404).json({ error: 'no such endpoint' }));

  // JSON errors for /api, always. An HTML stack trace inside a fetch() is a bug
  // report nobody can read — and a stack trace in a response body is a leak.
  api.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    console.error(`api error ${req.method} ${req.originalUrl}`, err);
    if (res.headersSent) return;
    // A database constraint refusing a write is the server rejecting the
    // REQUEST, not the server breaking. "Something broke on our side" for a
    // CHECK violation sent an operator hunting a crash that was actually a
    // validation gap — three identical retries against the same constraint,
    // each told the same lie. The constraint name is schema, not content, and
    // it is the one word a bug report needs.
    const pgCode = (err as { code?: unknown })?.code;
    if (pgCode === '23514' || pgCode === '23505' || pgCode === '23503') {
      const constraint = String((err as { constraint_name?: unknown; constraint?: unknown }).constraint_name
        ?? (err as { constraint?: unknown }).constraint ?? 'a database rule');
      res.status(409).json({
        error: `the database refused that: it violates ${constraint}. This is a validation gap — `
          + 'the request should have been refused with a clearer reason. Please report it, quoting the rule name.',
      });
      return;
    }
    res.status(500).json({ error: 'something broke on our side' });
  });

  app.use('/api', api);

  // Last: the SPA and its security headers. Mounted after /api so an unknown
  // endpoint still answers with the API's JSON 404 rather than an HTML page.
  mountWebApp(app, { dir: cfg.webDir });

  return app;
}
