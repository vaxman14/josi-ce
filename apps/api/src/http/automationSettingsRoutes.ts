import { Router, type Request, type Response } from 'express';
import { ProtectedAdminError, reauthenticateProtectedAdmin } from '@josi-ce/auth';
import {
  CardinalDraftStore, CARDINAL_ACTIONS, CARDINAL_RULE_GUIDANCE, CARDINAL_SCOPE_KEYS,
  cardinalDraftSaveBinding, cardinalDraftTestBinding, cardinalContentDigest, cardinalReviewInput, explainCardinalRule,
  testCardinalRule, validateCardinalRule, validateAutomationPermissionPolicy,
  loadMasterKey, vaultRecords, VaultError, VaultLockedError, VaultRecordError,
  ProtectedConfirmationError,
  type Db, type LoadOptions, type VaultRecordReference,
} from '@josi-ce/core';
import { loadStoredProvider, isExternalProvider, isLocalOnly, reviewConfiguredCardinalMeaning, type SpawnRunner } from '@josi-ce/llm';
import { asyncRoute, param } from './async.js';
import { requireSuperAdmin } from './authz.js';
import { ProtectedChanges, ProtectedChangeError } from './protectedChanges.js';
import { DeviceEnrollments } from './deviceEnrollments.js';

interface Context { db: Db; masterKey?: LoadOptions | false; fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>; codexRunner?: SpawnRunner; appUrl?: string }
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

/** Administrator-owned drafts, model advice, native enrollment and protected
 * review. No model tool or execution grant bypass. */
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
  const protectedChanges = new ProtectedChanges(db, master, context.appUrl ?? '');
  const enrollments = new DeviceEnrollments(db, master, context.appUrl ?? '');
  // Protected request failures must not reach the general DB-error logger:
  // a database error may include full rule/permission or projection contents.
  const nativeHandle = (fn: (req: Request, res: Response) => Promise<unknown>) => asyncRoute(async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    try { return await fn(req, res); }
    catch (error) {
      if (error instanceof ProtectedChangeError || error instanceof ProtectedAdminError) return res.status(error.status).json({ error: error.message });
      if (error instanceof VaultLockedError) return res.status(423).json({ error: error.message });
      if (error instanceof VaultError || error instanceof VaultRecordError || error instanceof ProtectedConfirmationError) return res.status(409).json({ error: error.message });
      return res.status(503).json({ error: 'The protected review could not finish reliably. Inspect current settings and start a new review; do not assume the change was applied.' });
    }
  });
  r.get('/catalog', handle(async (_req, res) => res.json({
    guidance: CARDINAL_RULE_GUIDANCE, actions: CARDINAL_ACTIONS, scopeKeys: CARDINAL_SCOPE_KEYS,
    restrictions: ['deny', 'maximum_task_duration'], unavailable: ['deny', 'pause'],
    capabilities: { modelReview: true, nativeReview: protectedChanges.enabled, permanentChanges: protectedChanges.enabled,
      deviceEnrollment: await enrollments.available(), execution: false },
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
    const reviewer = provider?.activated_at && provider.probed_at && provider.cap_chat === true && provider.updated_at
      ? { providerId: provider.provider, model: provider.model, configurationVersion: provider.updated_at, external: isExternalProvider(provider.provider) } : null;
    const canTransmit = !!reviewer && (!reviewer.external || !!provider?.external_acknowledged && !await isLocalOnly(db));
    // No provider call or credential resolution occurs during preview.
    return res.json({ reference: draft.reference, input, inputDigest: cardinalContentDigest(input), reviewer,
      canTransmit, reason: canTransmit ? 'Review this exact content and destination, then verify your administrator credentials to request advice.'
        : 'Activate a tested chat model and permit this destination in model settings before requesting advice.' });
  }));
  r.post('/rules/:id/test', handle(async (req, res) => {
    const expected = reference(req.body?.expected), selected = req.body?.reviewerIdentity;
    if (expected.recordId !== param(req, 'id') || typeof req.body?.approvedReviewInputDigest !== 'string'
      || !/^[a-f0-9]{64}$/.test(req.body.approvedReviewInputDigest)
      || !selected || typeof selected !== 'object' || Array.isArray(selected)
      || Object.keys(selected).sort().join(',') !== 'configurationVersion,model,providerId'
      || ![selected.providerId, selected.model, selected.configurationVersion].every(value => typeof value === 'string' && value.length <= 300)) {
      throw new SettingsError(400, 'Preview the exact saved rule and selected model before sending.');
    }
    const key = master(), actorUserId = req.user!.id, approvedReviewInputDigest: string = req.body.approvedReviewInputDigest;
    const provider = await loadStoredProvider(db, 'primary');
    if (!provider?.activated_at || !provider.probed_at || provider.cap_chat !== true || !provider.updated_at
      || provider.provider !== selected.providerId || provider.model !== selected.model || provider.updated_at !== selected.configurationVersion) {
      throw new SettingsError(409, 'The selected model changed. Preview the current destination again.');
    }
    const reviewerIdentity = { providerId: provider.provider, model: provider.model, configurationVersion: provider.updated_at };
    const binding = cardinalDraftTestBinding({ expected, approvedReviewInputDigest, reviewerIdentity });
    const proof = await reauthenticateProtectedAdmin(db, key, { ...binding, userId: actorUserId, sessionId: req.user!.session_id,
      password: typeof req.body?.password === 'string' ? req.body.password : '',
      mfaCode: typeof req.body?.mfaCode === 'string' ? req.body.mfaCode : undefined });
    const checkAuthority = async (tx: Db, actor: string, writing: boolean) => {
      await proof.check(tx, { ...binding, actorUserId: actor, consume: writing });
      const [current] = await tx.query<{ provider: string; model: string; updated_at: string; external_acknowledged: boolean }>(`select provider,model,updated_at::text as updated_at,external_acknowledged
        from llm_providers where role='primary' and activated_at is not null and probed_at is not null and cap_chat=true for share`);
      if (!current || current.provider !== reviewerIdentity.providerId || current.model !== reviewerIdentity.model
        || current.updated_at !== reviewerIdentity.configurationVersion) throw new SettingsError(409, 'The review model changed. Preview and test the current selection again.');
      if (isExternalProvider(current.provider) && (!current.external_acknowledged || await isLocalOnly(tx))) {
        throw new SettingsError(409, 'Model settings no longer permit this destination.');
      }
    };
    const store = new CardinalDraftStore(db, key, async (tx, actor, writing, command) => {
      if (command.purpose !== 'cardinal.draft.test' || command.requestDigest !== binding.requestDigest) {
        throw new SettingsError(403, 'This verification is only for the exact reviewed draft and model.');
      }
      await checkAuthority(tx, actor, writing);
    });
    const draft = await store.test({ actorUserId, expected, approvedReviewInputDigest, reviewerIdentity,
      reviewer: input => reviewConfiguredCardinalMeaning({ db, masterKey: key, fetchImpl: context.fetchImpl,
        resolve: context.resolve, codexRunner: context.codexRunner, timeoutMs: 90_000 }, {
        input, userId: actorUserId, reviewerIdentity,
        authorizeDispatch: async () => {
          if (req.aborted || res.destroyed) throw new SettingsError(409, 'The review request was closed.');
          // Re-open the exact Vault draft and recheck live account/session,
          // proof, epoch and selected model immediately before transmission.
          const current = await new CardinalDraftStore(db, key, checkAuthority).read({ actorUserId, recordId: expected.recordId, expected });
          const parsed = validateCardinalRule(current.document.draft);
          if (!parsed.valid || cardinalContentDigest(cardinalReviewInput(parsed.rule)) !== approvedReviewInputDigest) {
            throw new SettingsError(409, 'The review content changed. Preview it again.');
          }
        },
      }),
    });
    return res.json({ draft, permanent: false });
  }));
  r.post('/permissions/validate', handle(async (req, res) => {
    const parsed = validateAutomationPermissionPolicy(req.body?.policy);
    return res.json({ validation: parsed, permanent: false, executionEnabled: false });
  }));
  r.get('/devices/enroll/pending', nativeHandle(async (req, res) => res.json({
    requests: await enrollments.list(req.user!.id, req.user!.session_id),
  })));
  r.post('/devices/enroll/begin', nativeHandle(async (req, res) => res.status(201).json(
    await enrollments.begin(req.user!.id, req.user!.session_id, req.body?.label),
  )));
  r.post('/devices/enroll/:id/prepare', nativeHandle(async (req, res) => res.json(await enrollments.prepare({
    actor: req.user!.id, session: req.user!.session_id, id: param(req, 'id'), material: req.body?.material,
    password: typeof req.body?.password === 'string' ? req.body.password : '',
    mfaCode: typeof req.body?.mfaCode === 'string' ? req.body.mfaCode : undefined,
  }))));
  r.get('/devices/enroll/:id/status', nativeHandle(async (req, res) => res.json(
    await enrollments.status(req.user!.id, req.user!.session_id, param(req, 'id')),
  )));
  r.get('/devices/enroll/:id/review', nativeHandle(async (req, res) => res.json(
    await enrollments.review(req.user!.id, req.user!.session_id, param(req, 'id')),
  )));
  r.post('/devices/enroll/:id/commit', nativeHandle(async (req, res) => res.json(
    await enrollments.commit(req.user!.id, req.user!.session_id, param(req, 'id'), req.body?.possessionSignature),
  )));
  r.post('/devices/enroll/:id/cancel', nativeHandle(async (req, res) => res.json(
    enrollments.cancel(req.user!.id, req.user!.session_id, param(req, 'id')),
  )));
  r.post('/protected/prepare', nativeHandle(async (req, res) => res.status(201).json(await protectedChanges.prepare({
    actor: req.user!.id, session: req.user!.session_id, deviceId: req.body?.deviceId, change: req.body?.change,
    password: typeof req.body?.password === 'string' ? req.body.password : '',
    mfaCode: typeof req.body?.mfaCode === 'string' ? req.body.mfaCode : undefined,
  }))));
  r.get('/protected/:id/host-challenge', nativeHandle(async (req, res) => res.json({
    challenge: await protectedChanges.hostChallenge(req.user!.id, req.user!.session_id, param(req, 'id')),
  })));
  r.get('/protected/:id/current', nativeHandle(async (req, res) => res.json(
    await protectedChanges.isCurrent(req.user!.id, req.user!.session_id, param(req, 'id')),
  )));
  r.post('/protected/:id/presentation', nativeHandle(async (req, res) => res.json({
    challenge: await protectedChanges.presentation(req.user!.id, req.user!.session_id, param(req, 'id'), req.body?.proof),
  })));
  r.post('/protected/:id/projection', nativeHandle(async (req, res) => res.json({
    projection: await protectedChanges.projection(req.user!.id, req.user!.session_id, param(req, 'id'), req.body?.proof),
  })));
  r.post('/protected/:id/commit', nativeHandle(async (req, res) => {
    const result = await protectedChanges.commit(req.user!.id, req.user!.session_id, param(req, 'id'), req.body?.receipt);
    return res.json({ applied: true, kind: result.kind, reference: result.policy.reference });
  }));
  r.post('/protected/:id/cancel', nativeHandle(async (req, res) => {
    await protectedChanges.cancel(req.user!.id, req.user!.session_id, param(req, 'id')); return res.json({ cancelled: true });
  }));
  return r;
}
