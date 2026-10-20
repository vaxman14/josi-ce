import { Router, type Request, type Response } from 'express';
import { claudeCredentialStoreForInstallation, getSetupState, loadMasterKey, Secret,
  SubscriptionCredentialError, VaultError, VaultLockedError,
  type Db, type LoadOptions, type SubscriptionCredentialAdministration } from '@josi-ce/core';
import { vaultClaudeLoginStatus } from '@josi-ce/llm';
import { canSubmit } from '../setup/steps.js';
import { asyncRoute } from './async.js';
import { requireSuperAdmin } from './authz.js';

interface Context { db: Db; masterKey?: LoadOptions | false }
async function storeFor(context: Context) {
  if (context.masterKey === false) throw new VaultError('The installation key is unavailable.');
  let key;
  try { key = loadMasterKey(context.masterKey ?? {}); }
  catch { throw new VaultError('The installation key is unavailable.'); }
  const [owner] = await context.db.query<{ id: string }>(
    "select id from users where role='super_admin' and status='active' order by created_at,id limit 1");
  return claudeCredentialStoreForInstallation(context.db, key, owner?.id);
}
export async function claudeSubscriptionStatus(context: Context) {
  return vaultClaudeLoginStatus(await storeFor(context));
}

/** Both setup and administrator clients use one canonical Vault item.
 * Tokens are write-only request fields, never status, events or response data. */
export function claudeSubscriptionRouter(context: Context, setup = false): Router {
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
  const authority = (req: Request): SubscriptionCredentialAdministration => ({
    requireAdministrator: tx => currentAuthority(req)(tx),
    async requireConsumerStopped() {
      // A client assertion or lease expiry is not evidence of child closure.
      throw new SubscriptionCredentialError('The previous subscription consumer cannot be confirmed stopped.');
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
    } finally {
      if (req.body && typeof req.body === 'object') {
        delete req.body.token;
        delete req.body.code;
      }
    }
  });
  router.get('/status', handle(async (_req, res) => res.json({ cli: await claudeSubscriptionStatus(context) })));
  router.post('/connect', handle(async (req, res) => {
    if (typeof req.body?.token !== 'string' || !req.body.expected) {
      throw new SubscriptionCredentialError('Refresh subscription status and enter your Claude setup token.');
    }
    const token = new Secret(req.body.token);
    delete req.body.token;
    const store = await storeFor(context);
    await store.connect(token, req.body.expected, authority(req));
    return res.json({ cli: await vaultClaudeLoginStatus(store) });
  }));
  // Retired actions explain the settings upgrade without recreating an old
  // service-directory login. Ordinary remote chat remains on the same API.
  const reconnect = handle(async (_req, res) => res.status(409).json({
    error: 'This server stores Claude subscription tokens in the Vault. Open the updated Josi model settings to connect with a setup token.',
    state: 'failed', challenge: null,
  }));
  router.post('/login', reconnect);
  router.post('/login/code', reconnect);
  router.get('/login', handle(async (_req, res) => res.json({ state: 'idle', challenge: null, message: null })));
  router.post('/login/cancel', handle(async (_req, res) => res.json({ ok: true })));
  router.post('/logout', handle(async (req, res) => {
    const store = await storeFor(context), saved = await store.inspect();
    await store.disconnect(req.body?.expected ?? { itemId: saved.itemId, revision: saved.revision }, authority(req));
    return res.json({ ok: true, detail: 'The canonical Claude subscription token was removed from the Vault.' });
  }));
  return router;
}
