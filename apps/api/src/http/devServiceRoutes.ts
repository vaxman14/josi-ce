// Developer services: GitHub, Netlify, Vercel, Supabase.
//
// The whole surface, and what each route is not allowed to do:
//
//   GET    /developer-services              what I have connected, masked
//   POST   /developer-services/:service     paste a token; verified, then stored
//   POST   /developer-services/:id/test     ask the provider again
//   DELETE /developer-services/:id          delete our copy
//
//   GET    /admin/developer-services        health and the ceiling (metadata)
//   PUT    /admin/developer-services/policy/:service   deny-only
//   DELETE /admin/developer-services/connections/:id   cut one off
//
// Four claims, each with a test attacking it:
//
//   * NO RESPONSE FROM THIS FILE CONTAINS A TOKEN. Not the plaintext, not the
//     ciphertext, not a prefix, not a length. `maskedView` is the only shape
//     that goes to an owner and `adminView` the only shape that goes to an
//     administrator, and the second is run through `assertMetadataOnly`.
//   * A CONNECTION BELONGS TO ONE PERSON. Another member's id is 404 — not
//     403, which would confirm it exists. There is no share, no workspace
//     visibility, and no admin read.
//   * NOTHING IS STORED UNVERIFIED. The token goes to the provider first; a
//     row appears only after the provider accepted it.
//   * THE ADMIN CEILING ONLY DENIES. There is no route here that connects a
//     service for somebody else or turns one on.
import { Router, type Request, type Response } from 'express';
import { appendEvent, asSecret, loadMasterKey, type Db, type LoadOptions, type MasterKey } from '@josi-ce/core';
import {
  DEV_SERVICES, DevServiceError, DevServiceInputError, SERVICES, TOKEN_MASK,
  deleteDevConnection, devConnectionById, devConnectionsFor, devTokenFor, isDevService, probeDevService,
  recordCheck, saveDevConnection, servicePolicies, servicePolicy, validateProjectRef, validateToken,
  type DevService, type DevServiceConnectionRow,
} from '@josi-ce/connectors';
import { asyncRoute, param } from './async.js';
import { assertMetadataOnly, requireAuth, requireSuperAdmin } from './authz.js';

export interface DevServiceRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected by the tests. No suite contacts a real developer service. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the SSRF suite to answer with a hostile
   * address. Unset in production, where the host's own resolver is used. */
  resolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof DevServiceInputError) return res.status(400).json({ error: err.message });
      // A provider refusal is a 502 with a category: the request was fine, the
      // answer was not. The message is one CE wrote — never the provider's.
      if (err instanceof DevServiceError) {
        return res.status(502).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  });

function requireKey(ctx: DevServiceRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable');
  }
}

function serviceOf(req: Request): DevService {
  const raw = param(req, 'service');
  if (!isDevService(raw)) throw new RouteError(404, 'no such service');
  return raw;
}

/**
 * What the OWNER sees about their own connection.
 *
 * `tokenMask` is a constant. It is not the last four characters and not the
 * length — "which token is this?" is answered by `account`, which the provider
 * told us and which is not a credential. A mask derived from the secret is
 * still made of the secret.
 */
function maskedView(row: DevServiceConnectionRow) {
  return {
    id: row.id,
    service: row.service,
    account: row.account_label,
    projectRef: row.project_ref,
    // Null means "this provider does not report what a token covers". The UI
    // must not render that as an empty list.
    reportedScopes: row.reported_scopes,
    tokenMask: TOKEN_MASK,
    status: row.status,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
    lastErrorCategory: row.last_error_category,
    connectedAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** What the SUPER ADMIN sees about somebody else's: whose it is and whether it
 * works. Not the account handle, not the project, not the scopes, and not a
 * credential in any form. `assertMetadataOnly` is the backstop. */
function adminView(row: DevServiceConnectionRow & { username?: string }) {
  const dto = {
    id: row.id,
    owner_user_id: row.owner_user_id,
    username: row.username ?? null,
    service: row.service,
    status: row.status,
    last_check_at: row.last_check_at,
    last_check_ok: row.last_check_ok,
    last_error_category: row.last_error_category,
    created_at: row.created_at,
  };
  assertMetadataOnly(dto);
  return dto;
}

/** The administrator's ceiling, applied.
 *
 * Checked on every route that USES a credential, not only on the one that
 * stores it: a service switched off after somebody connected it would otherwise
 * carry on being exercised, and "switched off for this installation" would mean
 * "switched off for people who had not got round to it yet". Listing and
 * disconnecting are deliberately still permitted — taking a connection away is
 * never the thing a ceiling should block.
 */
async function assertAllowed(db: Db, service: DevService): Promise<void> {
  const { allowed, note } = await servicePolicy(db, service);
  if (allowed) return;
  throw new RouteError(
    403,
    note
      ? `An administrator has switched ${SERVICES[service].label} off for this installation: ${note}`
      : `An administrator has switched ${SERVICES[service].label} off for this installation.`,
  );
}

/** The guided setup, the least-privilege advice, and where to go to mint or
 * revoke a token. Static text from `SERVICES`, so reading it grants nothing and
 * a service with no connection still explains itself. */
function catalogue(service: DevService) {
  const spec = SERVICES[service];
  return {
    service: spec.key,
    label: spec.label,
    purpose: spec.purpose,
    apiHost: spec.apiHost,
    tokenUrl: spec.tokenUrl,
    steps: spec.steps,
    minimumPermissions: spec.minimumPermissions,
    scopeCaveat: spec.scopeCaveat,
    reportsScopes: spec.reportsScopes,
    revokeHint: spec.revokeHint,
  };
}

// ------------------------------------------------------------------ member

export function devServiceRoutes(ctx: DevServiceRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /** Every service, whether it is connected, and what connecting it would
   * require. Mine and only mine: the query is by `owner_user_id`, so there is
   * no id for a caller to substitute. */
  r.get(
    '/',
    handle(async (req, res) => {
      const rows = await devConnectionsFor(db, req.user!.id);
      const byService = new Map(rows.map((row) => [row.service, row]));
      const policy = await servicePolicies(db);
      return res.json({
        services: DEV_SERVICES.map((service) => {
          const admin = policy.get(service);
          return {
            ...catalogue(service),
            // Deny-only, and named so: `allowed` false means an administrator
            // forbade it, never that anything was switched on.
            allowedByAdmin: admin?.allowed ?? true,
            adminNote: admin?.allowed === false ? (admin.note ?? null) : null,
            connection: byService.has(service) ? maskedView(byService.get(service)!) : null,
          };
        }),
      });
    }),
  );

  /**
   * Connect, or replace the token on an existing connection.
   *
   * Order matters and is the point of the route: validate the shape, check the
   * administrator has not forbidden the service, ask the provider, and only
   * then store. A token that the provider refuses never reaches the database,
   * so a row that exists is a row that worked at least once.
   */
  r.post(
    '/:service',
    handle(async (req, res) => {
      const service = serviceOf(req);
      await assertAllowed(db, service);

      // Wrapped as a Secret on the line it arrives, so the window in which a
      // bare string could be logged by accident is one line long.
      const secret = asSecret(req.body?.token);
      const token = validateToken(service, secret.reveal());
      const projectRef = service === 'supabase' ? validateProjectRef(req.body?.projectRef) : null;

      // The master key is required BEFORE the provider is contacted: an
      // installation that cannot seal has no business sending somebody's token
      // anywhere, and finding out afterwards would mean a verified credential
      // with nowhere safe to put it.
      const key = requireKey(ctx);

      const probe = await probeDevService(service, { token, projectRef }, {
        fetchImpl: ctx.fetchImpl, resolve: ctx.resolve,
      });

      const row = await saveDevConnection(db, key, {
        ownerUserId: req.user!.id,
        service,
        token,
        accountLabel: probe.accountLabel,
        accountId: probe.accountId,
        reportedScopes: probe.reportedScopes,
        projectRef,
      });
      return res.status(201).json({ connection: maskedView(row) });
    }),
  );

  /** Ask the provider again, now.
   *
   * The stored answer goes stale the moment somebody revokes a token in their
   * GitHub settings, and "it worked when you saved it" is not what the page
   * should be claiming three weeks later. */
  r.post(
    '/:id/test',
    handle(async (req, res) => {
      const row = await ownedOr404(db, req, param(req, 'id'));
      // A stored connection is still subject to the ceiling: this route opens
      // the sealed token and sends it to a provider, which is exactly the use
      // an administrator switching the service off meant to stop.
      await assertAllowed(db, row.service);
      const key = requireKey(ctx);
      const token = devTokenFor(key, row);

      try {
        const probe = await probeDevService(row.service, { token, projectRef: row.project_ref }, {
          fetchImpl: ctx.fetchImpl, resolve: ctx.resolve,
        });
        await recordCheck(db, { connectionId: row.id, ok: true });
        // The account label can change (a renamed GitHub account, a new
        // Supabase project name); keep it truthful rather than frozen at
        // connect time. The token itself is untouched.
        await db.query(
          `update developer_service_connections
             set account_label = $2, account_id = $3, reported_scopes = $4
           where id = $1`,
          [row.id, probe.accountLabel, probe.accountId, probe.reportedScopes],
        );
        await appendEvent(db, {
          actorUserId: req.user!.id,
          actor: 'user',
          kind: 'developer_service.tested',
          subjectType: 'developer_service_connection',
          subjectId: row.id,
          payload: { service: row.service, ok: true },
        });
        const [fresh] = await db.query<DevServiceConnectionRow>(
          `select * from developer_service_connections where id = $1`, [row.id],
        );
        return res.json({ ok: true, connection: maskedView(fresh) });
      } catch (err) {
        const category = err instanceof DevServiceError ? err.category : 'provider_error';
        await recordCheck(db, { connectionId: row.id, ok: false, category });
        await appendEvent(db, {
          actorUserId: req.user!.id,
          actor: 'user',
          kind: 'developer_service.tested',
          subjectType: 'developer_service_connection',
          subjectId: row.id,
          // A category, never the provider's words and never the token.
          payload: { service: row.service, ok: false, category },
        });
        throw err;
      }
    }),
  );

  /** Disconnect. Deletes our copy and says what CE cannot do — none of these
   * four offers an API to revoke a personal access token, so the person
   * finishes the job in their own account. */
  r.delete(
    '/:id',
    handle(async (req, res) => {
      const row = await ownedOr404(db, req, param(req, 'id'));
      await deleteDevConnection(db, {
        connectionId: row.id, service: row.service, actorUserId: req.user!.id, actor: 'user',
      });
      return res.json({
        ok: true,
        note: `Josi has deleted its copy of that token. ${SERVICES[row.service].label} cannot be told to `
          + `revoke it from here, so revoke it yourself: ${SERVICES[row.service].revokeHint}`,
      });
    }),
  );

  return r;
}

/** Ownership, resolved from the row rather than from the request.
 *
 * A row that belongs to somebody else and a row that does not exist produce the
 * same 404, so the two are indistinguishable from outside. There is no role
 * branch here on purpose: an administrator using a member route is a member.
 */
async function ownedOr404(db: Db, req: Request, id: string): Promise<DevServiceConnectionRow> {
  const row = await devConnectionById(db, id);
  if (!row || row.owner_user_id !== req.user!.id) throw new RouteError(404, 'not found');
  return row;
}

// ------------------------------------------------------------------- admin

export function adminDevServiceRoutes(ctx: DevServiceRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** The ceiling and the health table. Metadata only. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const policy = await servicePolicies(db);
      const rows = await db.query<DevServiceConnectionRow & { username: string }>(
        `select c.*, u.username
           from developer_service_connections c join users u on u.id = c.owner_user_id
          order by u.username, c.service`,
      );
      return res.json({
        policy: DEV_SERVICES.map((service) => ({
          service,
          label: SERVICES[service].label,
          allowed: policy.get(service)?.allowed ?? true,
          note: policy.get(service)?.note ?? null,
        })),
        connections: rows.map(adminView),
      });
    }),
  );

  /** Deny-only, by construction: this writes `allowed`, and there is nothing
   * anywhere in this file that connects a service on somebody's behalf. */
  r.put(
    '/policy/:service',
    handle(async (req, res) => {
      const service = serviceOf(req);
      const allowed = req.body?.allowed !== false;
      const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) || null : null;
      await db.query(
        `insert into developer_service_policy (service, allowed, note) values ($1, $2, $3)
         on conflict (service) do update set allowed = excluded.allowed, note = excluded.note`,
        [service, allowed, note],
      );
      await appendEvent(db, {
        actorUserId: req.user!.id,
        actor: 'super_admin',
        kind: allowed ? 'developer_service.permitted' : 'developer_service.forbidden',
        payload: { service },
      });
      return res.json({ service, allowed, note });
    }),
  );

  /** An administrator may cut a connection off. That is plumbing: it removes
   * access, and at no point does it show them what was inside. Deliberately not
   * behind `ownedOr404` — acting on somebody else's row is the whole point, and
   * that is exactly why this route reads nothing from it. */
  r.delete(
    '/connections/:id',
    handle(async (req, res) => {
      const row = await devConnectionById(db, param(req, 'id'));
      if (!row) throw new RouteError(404, 'not found');
      await deleteDevConnection(db, {
        connectionId: row.id, service: row.service, actorUserId: req.user!.id, actor: 'super_admin',
      });
      return res.json({ ok: true });
    }),
  );

  return r;
}
