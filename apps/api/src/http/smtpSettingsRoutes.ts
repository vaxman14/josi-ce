import { Router, type Request, type Response } from 'express';
import { appendEvent, loadMasterKey, VaultError, VaultLockedError } from '@josi-ce/core';
import { listSmtpProfiles, loadProfile, saveSmtpProfiles, removeSmtpProfile, smtpTransport,
  MailError, NoProfileError, SmtpConfigurationError, type SmtpProfileInput, type SmtpProfileVersions } from '@josi-ce/mail';
import type { MailRoutesCtx } from './mailRoutes.js';
import { asyncRoute, param } from './async.js';
import { requireSuperAdmin } from './authz.js';

const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function versions(value: unknown): SmtpProfileVersions {
  if (!exact(value, ['system', 'communications']) || Object.values(value).some(v => v !== null && (typeof v !== 'string' || v.length > 100))) {
    throw new SmtpConfigurationError(400, 'Reload the saved email profiles before changing them.');
  }
  return value as SmtpProfileVersions;
}
function input(value: unknown, kind: 'system' | 'communications'): SmtpProfileInput {
  if (!exact(value, ['copyFromSystem', 'host', 'port', 'security', 'username', 'password', 'clearPassword', 'fromName', 'fromAddress'])
    || typeof value.copyFromSystem !== 'boolean' || kind === 'system' && value.copyFromSystem
    || typeof value.clearPassword !== 'boolean' || !Number.isInteger(value.port)
    || (['host', 'security', 'username', 'password', 'fromName', 'fromAddress'] as const).some(field =>
      typeof value[field] !== 'string' || (value[field] as string).length > (field === 'password' ? 4096 : 320))
    || (['host', 'username', 'fromName', 'fromAddress'] as const).some(field => /[\r\n\u0000]/.test(value[field] as string))) {
    throw new SmtpConfigurationError(400, 'Complete the supported email profile fields.');
  }
  return value as unknown as SmtpProfileInput;
}
/** Post-setup administration. The installation wizard stays closed. No route
 * accepts message bodies, arbitrary subjects or a credential-export request. */
export function smtpSettingsRoutes(context: MailRoutesCtx): Router {
  const r = Router(), db = context.db;
  r.use(requireSuperAdmin);
  const key = () => {
    if (context.masterKey === false) throw new SmtpConfigurationError(503, 'The installation key is unavailable.');
    try { return loadMasterKey(context.masterKey ?? {}); }
    catch { throw new SmtpConfigurationError(503, 'The installation key is unavailable.'); }
  };
  const handle = (work: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return await work(req, res); }
    catch (error) {
      if (error instanceof SmtpConfigurationError) return res.status(error.status).json({ error: error.message });
      if (error instanceof VaultLockedError) return res.status(423).json({ error: error.message });
      if (error instanceof VaultError || error instanceof NoProfileError) return res.status(409).json({ error: error.message });
      if (error instanceof MailError) return res.status(502).json({ error: 'The email server refused the test message. Check its connection, credentials and recipient.', category: error.category });
      // Do not forward/log DB error bodies from a credential mutation.
      return res.status(503).json({ error: 'The email operation could not be confirmed. Refresh the saved profiles; do not automatically repeat a test send.' });
    }
  });
  r.get('/', handle(async (_req, res) => res.json(await listSmtpProfiles(db))));
  r.put('/', handle(async (req, res) => {
    if (!exact(req.body, ['system', 'communications', 'expected'])) throw new SmtpConfigurationError(400, 'Review both exact email profiles.');
    await saveSmtpProfiles(db, key(), { actorUserId: req.user!.id, expected: versions(req.body.expected),
      system: input(req.body.system, 'system'), communications: input(req.body.communications, 'communications') });
    return res.json({ saved: true, ...(await listSmtpProfiles(db)) });
  }));
  r.delete('/:kind', handle(async (req, res) => {
    const kind = param(req, 'kind');
    if (!['system', 'communications'].includes(kind) || !exact(req.body, ['expected'])) throw new SmtpConfigurationError(400, 'Choose the exact saved email profile.');
    await removeSmtpProfile(db, key(), kind as 'system' | 'communications', req.user!.id, versions(req.body.expected));
    return res.json({ removed: true, ...(await listSmtpProfiles(db)) });
  }));
  r.post('/:kind/test', handle(async (req, res) => {
    const kind = param(req, 'kind');
    if (!['system', 'communications'].includes(kind) || !exact(req.body, ['to', 'configurationVersion'])
      || typeof req.body.to !== 'string' || !/^[^\s@<>,;]+@[^\s@<>,;]+$/.test(req.body.to) || req.body.to.length > 254
      || typeof req.body.configurationVersion !== 'string' || req.body.configurationVersion.length > 220) {
      throw new SmtpConfigurationError(400, 'Choose one recipient and the exact saved email profile.');
    }
    const profile = await loadProfile(db, key(), kind as 'system' | 'communications');
    if (profile.configurationVersion !== req.body.configurationVersion) throw new SmtpConfigurationError(409, 'Email settings changed. Refresh before sending a test.');
    // This is an explicit human-triggered test, never a page-load operation.
    // One send only; a lost response is not retried.
    await (context.transport ?? smtpTransport(profile)).send({
      from: profile.fromName ? `${profile.fromName} <${profile.fromAddress}>` : profile.fromAddress,
      replyTo: profile.fromAddress, to: [req.body.to], cc: [], subject: 'Josi test message',
      text: 'This is the test message you requested from Josi email settings. If you can read it, delivery reached this address. No account or workspace content is included.',
      headers: { 'Auto-Submitted': 'auto-generated' }, attachments: [],
    });
    await appendEvent(db, { actorUserId: req.user!.id, actor: 'super_admin', kind: 'smtp.test_accepted',
      payload: { profileKind: kind } });
    return res.json({ accepted: true, message: 'The server accepted one test message. Check the recipient’s inbox to confirm delivery.' });
  }));
  return r;
}
