// Developer services: the member's own connection, and the administrator's
// permission over it.
//
// The split is the point of this file. A person connects their own GitHub with
// their own token, in their own Workspace. An administrator decides who is
// permitted to do that at all — and never types a credential, because there is
// no installation-wide one to type.
//
// Two rules hold everywhere below:
//
//   * Permission is enforced on the WRITE, not by hiding a control. A screen
//     that omits a button is presentation; the route is the authorization.
//   * "Allowed" and "connected" are never conflated. An administrator looking
//     at a service that nobody uses has to be able to tell whether nobody
//     wanted it or nobody was permitted it.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, loadMasterKey, VaultError, VaultLockedError,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import {
  DEVELOPER_SERVICES, DEVELOPER_SERVICE_CATALOG, checkDeveloperCredentials, developerServiceFields, normalizeDeveloperFields,
  discoverObsidianVaults, readObsidianNote, DeveloperCredentialError, checkDeveloperCredentialAccess,
  saveDeveloperConnection, loadDeveloperCredentials, recordDeveloperCheck, deleteDeveloperConnection, withDeveloperServiceTransaction,
  isDeveloperService, isPermissionMode, mayConnect, summarizeScope, isDeveloperAccountKey, renameDeveloperAccount,
  MAX_DEVELOPER_ACCOUNTS_PER_SERVICE,
  type DeveloperService, type EffectiveScope, type PermissionMode, allowDeveloperServiceFor } from '@josi-ce/connectors';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

export interface DeveloperServiceCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected by the suites so no test reaches a real service. */
  fetchImpl?: typeof fetch;
}

class RouteError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The account a request names, in the body or the query. */
const accountOf = (req: Request): string | undefined => {
  const value = typeof req.body?.account === 'string' ? req.body.account : typeof req.query.account === 'string' ? req.query.account : '';
  return value.trim() || undefined;
};

const str = (v: unknown, max = 4000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof VaultLockedError) return res.status(423).json({ error: err.message });
      if (err instanceof VaultError) return res.status(409).json({ error: err.message });
      if (err instanceof RouteError || err instanceof DeveloperCredentialError) return res.status(err.status).json({ error: err.message });
      throw err;
    }
  });

function requireKey(ctx: DeveloperServiceCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable, so nothing can be saved securely.');
  }
}

interface PolicyRow { service: DeveloperService; mode: PermissionMode; note: string | null }

/** Every service's policy, with the named people attached.
 *
 * Read in one place so the member route and the admin route cannot disagree
 * about who is permitted. */
async function loadScopes(db: Db): Promise<Map<DeveloperService, EffectiveScope & { note: string | null }>> {
  const policies = await db.query<PolicyRow>(
    `select service, mode, note from developer_service_policy`,
  );
  const named = await db.query<{ service: DeveloperService; user_id: string }>(
    `select service, user_id from developer_service_allowed_users`,
  );
  const out = new Map<DeveloperService, EffectiveScope & { note: string | null }>();
  for (const service of DEVELOPER_SERVICES) {
    const policy = policies.find((p) => p.service === service);
    out.set(service, {
      // A service with no row has never been permitted, which is the same
      // answer as an explicit refusal rather than an error.
      mode: policy?.mode ?? 'not_allowed',
      note: policy?.note ?? null,
      allowedUserIds: named.filter((n) => n.service === service).map((n) => n.user_id),
    });
  }
  return out;
}

// ---------------------------------------------------------------- the member

export function developerServiceRoutes(ctx: DeveloperServiceCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /** What I may connect, and what I have connected. */
  r.get(
    '/',
    handle(async (req, res) => {
      const userId = req.user!.id;
      const scopes = await loadScopes(db);
      const mine = await db.query<{
        service: DeveloperService; account_key: string; nickname: string | null;
        account_label: string | null; status: string;
        last_check_at: string | null; last_check_ok: boolean | null; last_error: string | null;
        last_used_at: string | null;
      }>(
        `select service, account_key, nickname, account_label, status, last_check_at, last_check_ok, last_error, last_used_at
         from developer_connections where owner_user_id = $1
         order by (account_key = 'default') desc, created_at, account_key`,
        [userId],
      );
      const shown = (c: (typeof mine)[number]) => ({
        // Which account this is. Send it back as `account` to check, replace,
        // rename or remove this one and no other.
        account: c.account_key,
        // The person's own name for it, when they gave one.
        name: c.nickname,
        accountLabel: c.account_label,
        status: c.status,
        lastCheckAt: c.last_check_at,
        lastCheckOk: c.last_check_ok,
        lastError: c.last_error,
        lastUsedAt: c.last_used_at,
      });

      return res.json({
        services: DEVELOPER_SERVICE_CATALOG.map((d) => {
          const scope = scopes.get(d.service)!;
          const accounts = mine.filter((m) => m.service === d.service);
          const connection = accounts[0] ?? null;
          return {
            service: d.service,
            label: d.label,
            tokenLabel: d.tokenLabel,
            tokenHelp: d.tokenHelp,
            tokenUrl: d.tokenUrl,
            capability: d.capability,
            usernameLabel: d.usernameLabel ?? null,
            emailLabel: d.emailLabel ?? null,
            baseUrlLabel: d.baseUrlLabel ?? null,
            // The whole form, one entry per box, for every service. The label
            // keys above stay for clients written before this existed; a
            // client that reads `fields` needs nothing else to build the form.
            // These are descriptions of boxes, never their contents.
            fields: developerServiceFields(d),
            // Whether I MAY, kept separate from whether I HAVE.
            allowed: req.user!.role === 'super_admin' || mayConnect(scope, userId),
            // The administrator's own words when they refused it, so a person
            // is told why by the person who decided rather than by a generic
            // "not available".
            note: scope.note,
            // The first account, for clients written when there was only one.
            connection: connection ? shown(connection) : null,
            // Every account of this service. A person may connect as many as
            // they have.
            accounts: accounts.map(shown),
            maxAccounts: MAX_DEVELOPER_ACCOUNTS_PER_SERVICE,
          };
        }),
      });
    }),
  );

  /** Obsidian is native filesystem discovery, never a Sync credential. */
  r.get('/obsidian-vaults', requireSuperAdmin, handle(async (_req, res) => {
    try {
      const vaults = await discoverObsidianVaults(process.env.JOSI_WORKSPACE_ROOT || '/workspace');
      return res.json({ available: true, vaults });
    } catch {
      return res.json({ available: false, vaults: [], detail: 'The Local Workspace mount is not available.' });
    }
  }));

  r.get('/obsidian-note', requireSuperAdmin, handle(async(req,res)=>{
    try{return res.json(await readObsidianNote(process.env.JOSI_WORKSPACE_ROOT||'/workspace',String(req.query.vault??''),String(req.query.note??'')));}
    catch{throw new RouteError(400,'That Markdown note is unavailable inside the selected vault.');}
  }));

  /** Connect, with my own token or key.
   *
   * The body carries the service's field keys (see `fields` on the catalog):
   * `token` and friends for a token service, the parts of the signing key for
   * a store. It is checked against the service before it is stored. Storing an
   * unverified credential would let somebody leave this screen believing they
   * had connected something.
   *
   * WHICH ACCOUNT. `account` in the body (or the query) says where it goes:
   * absent is the first account, exactly as before there could be several;
   * "new" adds another account; an account key replaces that account's
   * credential. `name` is the person's own name for it. */
  const connect = async (req: Request, res: Response, forced?: string) => {
    const service = param(req, 'service');
    if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
    const userId = req.user!.id;

    const scopes = await loadScopes(db);
    const scope = scopes.get(service)!;
    if (req.user!.role !== 'super_admin' && !mayConnect(scope, userId)) {
      // 403 with the administrator's reason where there is one. Not 404: the
      // service plainly exists, and pretending otherwise would send somebody
      // looking for a bug instead of asking their administrator.
      throw new RouteError(
        403,
        scope.note
          ? `An administrator has not permitted this service here. ${scope.note}`
          : 'An administrator has not permitted this service here.',
      );
    }
    const account = forced ?? accountOf(req);
    if (account !== undefined && account !== 'new' && !isDeveloperAccountKey(account)) {
      throw new RouteError(400, 'account is "new" or the key of an account you have connected');
    }

    // Held for this one request and nothing else: not stored in the clear,
    // not logged, not echoed back. A key that cannot be a key at all is
    // refused here, before anything is asked of the service.
    const entered = normalizeDeveloperFields(service, req.body);
    if (!entered.ok) throw new RouteError(400, entered.detail);

    const key = requireKey(ctx);
    await checkDeveloperCredentialAccess(db, userId, service);
    const check = await checkDeveloperCredentials({ service, values: entered.values, fetchImpl: ctx.fetchImpl });
    if (!check.ok) {
      throw new RouteError(400, check.detail);
    }

    // Every field goes into the Vault together, as one sealed payload.
    const saved = await saveDeveloperConnection(db, key, { ownerUserId: userId, service, accountLabel: check.accountLabel ?? null,
      credentials: entered.values, account,
      name: typeof req.body?.name === 'string' ? req.body.name : undefined });
    return res.status(saved.created && account === 'new' ? 201 : 200)
      .json({ ok: true, accountLabel: check.accountLabel ?? null, account: saved.account, created: saved.created, detail: check.detail });
  };
  r.put('/:service', handle((req, res) => connect(req, res)));
  /** Add another account of this service. */
  r.post('/:service/accounts', handle((req, res) => connect(req, res, 'new')));
  /** Replace one account's credential. */
  r.put('/:service/accounts/:account', handle((req, res) => connect(req, res, param(req, 'account'))));

  /** Give one account a name of my own. */
  r.patch('/:service/accounts/:account', handle(async (req, res) => {
    const service = param(req, 'service');
    if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
    if (!(await renameDeveloperAccount(db, { ownerUserId: req.user!.id, service, account: param(req, 'account'), name: req.body?.name }))) {
      throw new RouteError(404, 'no such account');
    }
    return res.json({ ok: true });
  }));

  /** Re-check my own connection: the one named by `account`, or the only one. */
  const recheck = async (req: Request, res: Response, forced?: string) => {
    const service = param(req, 'service');
    if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
    const { credentials: opened, reference, account } = await loadDeveloperCredentials(db, requireKey(ctx), {
      ownerUserId: req.user!.id, service, requireActive: false, account: forced ?? accountOf(req) });
    const check = await checkDeveloperCredentials({ service, values: opened, fetchImpl: ctx.fetchImpl });
    if (!(await recordDeveloperCheck(db, { ownerUserId: req.user!.id, service, reference, check })))
      throw new RouteError(409, 'The connection or its permission changed during the check. Check the current connection again.');
    return res.json({ ok: check.ok, detail: check.detail, account });
  };
  r.post('/:service/check', handle((req, res) => recheck(req, res)));
  r.post('/:service/accounts/:account/check', handle((req, res) => recheck(req, res, param(req, 'account'))));

  /** Disconnect. The token goes with the row. Without `account` this removes
   * every account of the service, which is what it did when there was one. */
  r.delete(
    '/:service',
    handle(async (req, res) => {
      const service = param(req, 'service');
      if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
      await deleteDeveloperConnection(db, req.user!.id, service, accountOf(req));
      return res.status(204).end();
    }),
  );
  r.delete('/:service/accounts/:account', handle(async (req, res) => {
    const service = param(req, 'service');
    if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
    const removed = await deleteDeveloperConnection(db, req.user!.id, service, param(req, 'account'));
    if (!removed) throw new RouteError(404, 'no such account');
    return res.status(204).end();
  }));

  return r;
}

// ----------------------------------------------------------------- the admin

export function adminDeveloperServiceRoutes(ctx: DeveloperServiceCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** One person may connect one service from now on (a member's request the
   * owner approved in the app). Keeps whoever was already allowed. */
  r.post(
    '/:service/allow',
    handle(async (req, res) => {
      const service = param(req, 'service');
      if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');
      const userId = typeof req.body?.userId === 'string' ? req.body.userId : '';
      const [person] = await db.query<{ id: string }>(`select id from users where id = $1`, [userId]);
      if (!person) throw new RouteError(404, 'no such user');
      const result = await allowDeveloperServiceFor(db, { service, userId, actorUserId: req.user!.id });
      return res.json({ ok: true, ...result });
    }),
  );

  /** The permission for each service, and separately the health of whoever has
   * connected one.
   *
   * There is no credential field anywhere in this response and no route below
   * that accepts one. An administrator governs who may connect; the token is
   * the connecting person's own. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const scopes = await loadScopes(db);
      const people = await db.query<{ id: string; username: string; email: string }>(
        `select id, username, email from users where role in ('member', 'super_admin')
         order by username`,
      );
      const health = await db.query<{
        service: DeveloperService; owner_user_id: string; username: string;
        account_label: string | null; status: string; account_key: string;
        last_check_at: string | null; last_check_ok: boolean | null; last_error: string | null;
        last_used_at: string | null;
      }>(
        `select c.service, c.owner_user_id, u.username, c.account_label, c.status, c.account_key,
                c.last_check_at, c.last_check_ok, c.last_error, c.last_used_at
         from developer_connections c
         join users u on u.id = c.owner_user_id
         order by c.service, u.username, (c.account_key = 'default') desc, c.created_at`,
      );
      const nameById = new Map(people.map((p) => [p.id, p.username]));

      return res.json({
        // Everyone who could be named, for the selector. Username and email
        // only — enough to tell two people apart and nothing else.
        people: people.map((p) => ({ id: p.id, username: p.username, email: p.email })),
        services: DEVELOPER_SERVICE_CATALOG.map((d) => {
          const scope = scopes.get(d.service)!;
          const connections = health.filter((h) => h.service === d.service);
          return {
            service: d.service,
            label: d.label,
            capability: d.capability,
            // The permission.
            mode: scope.mode,
            allowedUserIds: scope.allowedUserIds,
            note: scope.note,
            summary: summarizeScope(
              scope,
              scope.allowedUserIds.map((id) => nameById.get(id) ?? 'someone removed'),
            ),
            // And, separately, who has actually connected. A service permitted
            // for everyone with nobody connected is a different fact from a
            // service nobody may connect, and the two must not be read off the
            // same number.
            connections: connections.map((c) => ({
              userId: c.owner_user_id,
              username: c.username,
              account: c.account_key,
              accountLabel: c.account_label,
              status: c.status,
              lastCheckAt: c.last_check_at,
              lastCheckOk: c.last_check_ok,
              lastError: c.last_error,
              lastUsedAt: c.last_used_at,
            })),
          };
        }),
      });
    }),
  );

  /** Set who may connect a service.
   *
   * Naming people does not connect anything for them, and un-naming somebody
   * does not delete what they already connected — it stops them using it, and
   * the connection row stays so that re-permitting them does not make them
   * paste a token again. Deleting somebody's credential is theirs to do. */
  r.put(
    '/:service',
    handle(async (req, res) => {
      const service = param(req, 'service');
      if (!isDeveloperService(service)) throw new RouteError(404, 'no such service');

      const mode = req.body?.mode;
      if (!isPermissionMode(mode)) {
        throw new RouteError(400, 'choose whether this is allowed, and for whom');
      }
      const note = str(req.body?.note, 500) || null;
      // Absent and empty are different requests. An absent `userIds` means
      // "leave the list as it is"; an empty array means "nobody", which is a
      // real choice an administrator part-way through selecting can make.
      const sentUserIds = Array.isArray(req.body?.userIds);
      const userIds: string[] = sentUserIds
        ? req.body.userIds.filter((v: unknown): v is string => typeof v === 'string').slice(0, 500)
        : [];

      await withDeveloperServiceTransaction(db, service, async tx => {
        // An empty list with `specific_users` is permitted and means nobody. It
        // is a real state — an administrator part-way through choosing — and
        // refusing it would force them to pick somebody they did not mean to.
        await tx.query(
          `insert into developer_service_policy (service, mode, note, updated_at, updated_by)
           values ($1, $2, $3, now(), $4)
           on conflict (service) do update set
             mode = excluded.mode, note = excluded.note,
             updated_at = now(), updated_by = excluded.updated_by`,
          [service, mode, note, req.user!.id],
        );

        if (mode === 'specific_users' && sentUserIds) {
          // Replace the list rather than merge it: the request carries the whole
          // selection, and merging would make removing somebody impossible.
          const valid = userIds.length
            ? await tx.query<{ id: string }>(
              `select id from users where id = any($1::uuid[])`, [userIds],
            )
            : [];
          await tx.query(`delete from developer_service_allowed_users where service = $1`, [service]);
          for (const row of valid) {
            await tx.query(
              `insert into developer_service_allowed_users (service, user_id) values ($1, $2)
               on conflict do nothing`,
              [service, row.id],
            );
          }
        }
        // Other modes, and a request that names no list at all, leave the stored
        // list alone on purpose: an administrator who switches to "everyone" and
        // back has not lost the list they built.

        await appendEvent(tx, {
          actorUserId: req.user!.id,
          actor: 'super_admin',
          kind: 'developer_service.policy_set',
          payload: { service, mode, namedCount: mode === 'specific_users' ? userIds.length : 0 },
        });
      });
      return res.json({ ok: true });
    }),
  );

  return r;
}
