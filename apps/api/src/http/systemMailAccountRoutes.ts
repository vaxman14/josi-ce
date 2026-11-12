// Which account sends Josi's own email (sign-in codes, password resets, notices
// to the owner), after setup. Setup asks the same question once; this is where
// the owner looks at the answer and changes it. Owner only. No secret is read
// or returned: an account is named by its email address.
import { Router } from 'express';
import { listSmtpProfiles } from '@josi-ce/mail';
import { clearSystemMailAccount, connectionsFor, grantsMailSend, setSystemMailAccount, SystemMailAccountError, systemMailAccount } from '@josi-ce/connectors';
import type { Db } from '@josi-ce/core';
import { asyncRoute } from './async.js';
import { requireSuperAdmin } from './authz.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function systemMailAccountRoutes(ctx: { db: Db }): Router {
  const { db } = ctx;
  const r = Router();
  r.use(requireSuperAdmin);
  r.use((_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

  async function view(ownerId: string) {
    const [account, smtp] = await Promise.all([systemMailAccount(db), listSmtpProfiles(db)]);
    const own = [...await connectionsFor(db, { ownerUserId: ownerId, provider: 'google' }), ...await connectionsFor(db, { ownerUserId: ownerId, provider: 'microsoft' })];
    const system = smtp.profiles.find(p => p.kind === 'system');
    return {
      account,
      smtp: system && system.host ? { host: system.host, fromAddress: system.fromAddress, fromName: system.fromName } : null,
      // What currently sends: the chosen account wins, then the mail server.
      sending: account ? (account.active ? 'account' : 'account_broken') : system && system.host ? 'smtp' : 'none',
      candidates: own.filter(c => c.status === 'active' && c.account_email).map(c => ({
        connectionId: c.id, provider: c.provider, accountEmail: c.account_email, canSend: grantsMailSend(c) })),
    };
  }

  r.get('/', asyncRoute(async (req, res) => res.json(await view(req.user!.id))));
  r.put('/', asyncRoute(async (req, res) => {
    const connectionId = typeof req.body?.connectionId === 'string' ? req.body.connectionId : '';
    if (!UUID.test(connectionId)) return res.status(400).json({ error: 'Choose one of your connected accounts.' });
    const fromName = typeof req.body?.fromName === 'string' ? req.body.fromName : null;
    try { await setSystemMailAccount(db, { connectionId, fromName, actorUserId: req.user!.id }); }
    catch (error) {
      if (error instanceof SystemMailAccountError) return res.status(409).json({ error: error.message });
      throw error;
    }
    return res.json(await view(req.user!.id));
  }));
  r.delete('/', asyncRoute(async (req, res) => {
    await clearSystemMailAccount(db, req.user!.id);
    return res.json(await view(req.user!.id));
  }));
  return r;
}
