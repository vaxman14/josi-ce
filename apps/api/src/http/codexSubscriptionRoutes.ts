import { Router, type Request, type Response } from 'express';
import { codexCredentialStoreForInstallation, getSetupState, loadMasterKey,
  SubscriptionCredentialError, VaultError, VaultLockedError,
  type Db, type LoadOptions, type SubscriptionCredentialAdministration } from '@josi-ce/core';
import { VaultDeviceLogin, vaultCodexLoginStatus } from '@josi-ce/llm';
import { canSubmit } from '../setup/steps.js';
import { asyncRoute } from './async.js';
import { requireSuperAdmin } from './authz.js';
import { confirmNativeCodexConsumerStopped } from './nativeConsumerEvidence.js';

interface Context { db: Db; masterKey?: LoadOptions | false }
interface Live { login: VaultDeviceLogin; caller: string }
// Setup and post-setup share the same controller for this API/database. The
// Vault claim remains the cross-process authority, including background work.
const live = new WeakMap<Db, Live>();
const idle = { state: 'idle', challenge: null, expiresAt: null, message: null };
async function storeFor(context: Context) {
  if (context.masterKey === false) throw new VaultError('The installation key is unavailable.');
  let key;
  try { key = loadMasterKey(context.masterKey ?? {}); }
  catch { throw new VaultError('The installation key is unavailable.'); }
  const [owner] = await context.db.query<{ id: string }>(
    "select id from users where role='super_admin' and status='active' order by created_at,id limit 1");
  return codexCredentialStoreForInstallation(context.db, key, owner?.id);
}
export async function codexSubscriptionStatus(context: Context) {
  return vaultCodexLoginStatus(await storeFor(context));
}
/** Compatibility response paths remain stable for native, web and remote
 * clients. Secret material is confined to the canonical Vault and guardian IPC. */
export function codexSubscriptionRouter(context: Context, setup = false): Router {
  const router = Router(), db = context.db;
  if (!setup) router.use(requireSuperAdmin);
  const currentAuthority = (req: Request) => async (tx: Db = db) => {
    if (setup) {
      const [state] = await tx.query<{ completed: boolean; completed_steps: string[] }>(
        'select completed,completed_steps from setup_state where id=true for share');
      if (!state || state.completed || !canSubmit('llm', state.completed_steps).ok) {
        throw new SubscriptionCredentialError('Subscription setup is unavailable at this installation step.');
      }
    } else {
      const [account] = await tx.query("select id from users where id=$1 and status='active' and role='super_admin' for share", [req.user?.id]);
      const [session] = await tx.query(`select id from sessions where id=$1 and user_id=$2
        and revoked_at is null and expires_at>now() for share`, [req.user?.session_id, req.user?.id]);
      if (!account || !session) throw new SubscriptionCredentialError('Sign in again with the current administrator account.');
    }
  };
  const caller = (req: Request) => setup ? 'setup' : `${req.user!.id}:${req.user!.session_id}`;
  const controller = (req: Request) => {
    const value = live.get(db);
    if (value && value.caller !== caller(req)) {
      throw new SubscriptionCredentialError('A different administrator session owns the current sign-in. Use that session to finish or cancel it.');
    }
    return value?.login;
  };
  const authority = (req: Request): SubscriptionCredentialAdministration => ({
    requireAdministrator: tx => currentAuthority(req)(tx),
    async requireConsumerStopped(_tx, review) {
      const login = controller(req);
      if (login) { login.requireStopped(review.leaseId); return; }
      // No login controller here: the run was in the worker, or in an API
      // process since restarted. On the Windows native runtime this host's
      // process list is the evidence; elsewhere this refuses as before.
      await confirmNativeCodexConsumerStopped();
    },
  });
  const handle = (work: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try {
      if (setup && (await getSetupState(db)).completed) return res.status(404).json({ error: 'not found' });
      await currentAuthority(req)();
      return await work(req, res);
    } catch (error) {
      if (error instanceof VaultLockedError) return res.status(423).json({ error: error.message });
      if (error instanceof SubscriptionCredentialError || error instanceof VaultError) {
        return res.status(409).json({ error: error.message });
      }
      return res.status(503).json({ error: 'The subscription operation could not be confirmed. Refresh status before trying again.' });
    }
  });
  router.get('/status', handle(async (_req, res) => res.json({ cli: await codexSubscriptionStatus(context) })));
  router.post('/login', handle(async (req, res) => {
    const existing = live.get(db);
    if (existing?.login.running) {
      const login = controller(req)!;
      return res.json(login.status);
    }
    const store = await storeFor(context), saved = await store.inspect();
    if (live.get(db)?.login.running) return res.json(controller(req)!.status);
    if (saved.state === 'leased') {
      throw new SubscriptionCredentialError('The previous subscription run still owns its login. Cancel or reconcile that run before starting another.');
    }
    const expected = req.body?.expected ?? { itemId: saved.itemId, revision: saved.revision };
    const login = new VaultDeviceLogin(store);
    // Reserve in-memory ownership before awaiting the claim, so another
    // request cannot replace a live challenge before start() resolves.
    live.set(db, { login, caller: caller(req) });
    return res.json(await login.start(expected, authority(req), currentAuthority(req)));
  }));
  router.get('/login', handle(async (req, res) => {
    const login = controller(req);
    if (!login) return res.json(idle);
    const snapshot = login.status;
    if (snapshot.state === 'signed_in' && !(await codexSubscriptionStatus(context)).signedIn) {
      return res.json({ state: 'failed', challenge: null, expiresAt: null,
        message: 'The saved login is no longer available. Refresh subscription status.' });
    }
    return res.json(snapshot);
  }));
  router.post('/login/cancel', handle(async (req, res) => {
    await controller(req)?.cancel();
    return res.json({ ok: true });
  }));
  router.post('/logout', handle(async (req, res) => {
    const store = await storeFor(context), saved = await store.inspect();
    if (saved.state === 'leased') throw new SubscriptionCredentialError('Finish or cancel the active subscription run before signing out.');
    await store.disconnect(req.body?.expected ?? { itemId: saved.itemId, revision: saved.revision }, authority(req));
    live.delete(db);
    return res.json({ ok: true, detail: 'The canonical subscription login was removed from the Vault.' });
  }));
  router.post('/reconcile', handle(async (req, res) => {
    // Only exact local stop evidence can reconcile this endpoint; a client
    // cannot turn a timeout, boolean or "I stopped it" into authority.
    const store = await storeFor(context);
    if (!req.body?.expected) throw new SubscriptionCredentialError('Refresh and review the current login before reconciling it.');
    await store.disconnect(req.body.expected, authority(req), true);
    live.delete(db);
    return res.json({ ok: true, detail: 'The stopped run was cleared. Sign in again to reconnect.' });
  }));
  return router;
}
