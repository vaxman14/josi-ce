import { Router, type Request, type Response } from 'express';
import { ProtectedAdminError, reauthenticateProtectedAdmin } from '@josi-ce/auth';
import {
  CardinalDraftStore, CARDINAL_ACTIONS, CARDINAL_RULE_GUIDANCE, CARDINAL_SCOPE_KEYS,
  cardinalDraftSaveBinding, cardinalContentDigest, cardinalReviewInput, explainCardinalRule,
  testCardinalRule, validateCardinalRule, validateAutomationPermissionPolicy,
  loadMasterKey, vaultRecords, VaultError, VaultLockedError, VaultRecordError,
  type Db, type LoadOptions, type VaultRecordReference,
} from '@josi-ce/core';
import { loadStoredProvider, isExternalProvider } from '@josi-ce/llm';
import { asyncRoute, param } from './async.js';
import { requireSuperAdmin } from './authz.js';

interface Context { db: Db; masterKey?: LoadOptions | false }
class SettingsError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const handle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  try { return await fn(req, res); }
  catch (error) {
    if (error instanceof SettingsError || error instanceof ProtectedAdminError) return res.status(error.status).json({ error: error.message });
    if (error instanceof VaultLockedError) return res.status(423).json({ error: error.message });
    if (error instanceof VaultError || error instanceof VaultRecordError) return res.status(409).json({ error: error.message });
    throw error;
  }
});
function reference(value: unknown): VaultRecordReference {
  const ref = value as VaultRecordReference;
  if (!ref || typeof ref !== 'object' || Array.isArray(ref)
    || Object.keys(ref).sort().join(',') !== 'digest,epoch,recordId,version'
    || typeof ref.recordId !== 'string' || !/^[a-f0-9-]{36}$/i.test(ref.recordId)
    || !Number.isSafeInteger(ref.version) || ref.version < 1 || !Number.isSafeInteger(ref.epoch) || ref.epoch < 1
    || typeof ref.digest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.digest)) throw new SettingsError(400, 'Refresh the saved rule before editing it.');
  return { ...ref };
}

/** Inspection and draft preparation only. No HTTP permanent-policy mutation,
 * key enrollment or model-transmission authorization is installed here. */
export function automationSettingsRoutes(context: Context): Router {
  const r = Router(), db = context.db;
  r.use(requireSuperAdmin);
  const master = () => {
    if (context.masterKey === false) throw new SettingsError(503, 'The installation key is unavailable.');
    try { return loadMasterKey(context.masterKey ?? {}); }
    catch { throw new SettingsError(503, 'The installation key is unavailable.'); }
  };
  const unavailable = async () => { throw new SettingsError(503, 'Protected native confirmation is not connected.'); };
  const noMutation = { verifyFreshAdministrator: unavailable, verifyProtectedHuman: unavailable };
  const noDeviceMutation = { requireServerIdentity: unavailable, verifyFreshAdministrator: unavailable,
    verifyEnrollmentConsent: unavailable, verifyProtectedRevocation: unavailable, verifyHostProjection: unavailable };
  r.get('/catalog', handle(async (_req, res) => res.json({
    guidance: CARDINAL_RULE_GUIDANCE, actions: CARDINAL_ACTIONS, scopeKeys: CARDINAL_SCOPE_KEYS,
    restrictions: ['deny', 'maximum_task_duration'], unavailable: ['deny', 'pause'],
    capabilities: { modelReview: false, permanentChanges: false, deviceEnrollment: false, execution: false },
  })));
  r.get('/', handle(async (req, res) => {
    const key = master(), records = vaultRecords(db, key);
    // Separate reads can encounter an epoch change. Each result carries its
    // own reference; a mutation must reload/compare rather than combine them.
    const rules = await records.cardinalPolicy(noMutation).read(req.user!.id);
    const permissions = await records.automationPolicy(noMutation).read(req.user!.id);
    const drafts = await new CardinalDraftStore(db, key).list(req.user!.id);
    const devices = await records.protectedDevices(noDeviceMutation).inventory(req.user!.id);
    return res.json({ rules, permissions, drafts, devices });
  }));
  r.post('/rules/validate', handle(async (req, res) => {
    const parsed = validateCardinalRule(req.body?.draft);
    return res.json({ report: testCardinalRule(req.body?.draft ?? null),
      meaning: parsed.valid ? explainCardinalRule(parsed.rule) : null,
      modelReview: { status: 'not_requested' }, permanent: false });
  }));
  r.post('/rules/save', handle(async (req, res) => {
    const parsed = validateCardinalRule(req.body?.draft);
    if (!parsed.valid) return res.status(400).json({ error: 'Complete the explicit supported fields before saving.', issues: parsed.issues });
    const expected = req.body?.expected === undefined ? undefined : reference(req.body.expected);
    const key = master(), binding = cardinalDraftSaveBinding(parsed.rule, expected);
    const proof = await reauthenticateProtectedAdmin(db, key, { ...binding, userId: req.user!.id, sessionId: req.user!.session_id,
      password: typeof req.body?.password === 'string' ? req.body.password : '',
      mfaCode: typeof req.body?.mfaCode === 'string' ? req.body.mfaCode : undefined });
    const store = new CardinalDraftStore(db, key, (tx, actorUserId, writing, command) => {
      if (command.purpose !== 'cardinal.draft.save') throw new SettingsError(403, 'This verification is only for the reviewed draft.');
      return proof.check(tx, { purpose: 'cardinal.draft.save', requestDigest: command.requestDigest, actorUserId, consume: writing });
    });
    const draft = await store.save({ actorUserId: req.user!.id, draft: parsed.rule, expected });
    return res.status(expected ? 200 : 201).json({ draft, permanent: false });
  }));
  r.post('/rules/:id/review-preview', handle(async (req, res) => {
    const expected = reference(req.body?.expected);
    if (expected.recordId !== param(req, 'id')) throw new SettingsError(400, 'Choose the exact saved rule.');
    const draft = await new CardinalDraftStore(db, master()).read({ actorUserId: req.user!.id, recordId: expected.recordId, expected });
    const parsed = validateCardinalRule(draft.document.draft);
    if (!parsed.valid) throw new SettingsError(400, 'Complete the supported fields before requesting a model review.');
    const input = cardinalReviewInput(parsed.rule), provider = await loadStoredProvider(db, 'primary');
    const reviewer = provider?.activated_at && provider.updated_at
      ? { providerId: provider.provider, model: provider.model, configurationVersion: provider.updated_at, external: isExternalProvider(provider.provider) } : null;
    // This previews exact minimized content. It does not call a provider or
    // interpret a web checkbox as the protected disclosure authorization.
    return res.json({ reference: draft.reference, input, inputDigest: cardinalContentDigest(input), reviewer,
      canTransmit: false, reason: 'Protected native confirmation must be connected before sending rule wording to the selected model.' });
  }));
  r.post('/permissions/validate', handle(async (req, res) => {
    const parsed = validateAutomationPermissionPolicy(req.body?.policy);
    return res.json({ validation: parsed, permanent: false, executionEnabled: false });
  }));
  return r;
}
