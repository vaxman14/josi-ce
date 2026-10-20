import { randomUUID } from 'node:crypto';
import type { AutomationAction, AutomationIdentity } from '@josi-ce/protocol';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { Secret } from './sealing.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { isAutomationIdentity, type AutomationPermissionEffect } from './automationPermissions.js';
import { vaultRecords, type VaultRecordReference } from './vault.js';
import type { AutomationReservationProofPort, AutomationReservationView } from './automationReservations.js';
import { requireWorkContinuation, requireReviewedWorkOutcome } from './workContinuation.js';
import { requireCurrentWorkMemory } from './workMemoryContext.js';
import { refuseMemorySecret } from './memorySafety.js';
import { workDependenciesSatisfied, type WorkGoalStep } from './workPlan.js';

export interface AutomationWorkspaceSummary {
  identity: AutomationIdentity; label: string; isolated: true;
  browserFamilies: Array<'chrome' | 'firefox' | 'safari' | 'brave'>;
  computerUse: boolean; state: 'ready' | 'paused' | 'needs_local_consent' | 'offline';
}
/** Populated by the authenticated server/harness, never tool arguments. */
export interface AutomationExecutionContext {
  ownerUserId: string; threadId: string; turnId: string; leaseToken: string; workMemoryVersion: number;
}
export interface AutomationRequest {
  taskId: string; workspaceId: string; observationId: string; action: AutomationAction;
}
export interface PreparedAutomationOperation {
  identity: AutomationIdentity; observationId: string; intentDigest: string;
  effects: AutomationPermissionEffect[]; effectCoverage: 'verified';
  expected: { permissions: VaultRecordReference; cardinal: VaultRecordReference };
  expiresAtMs: number; payload: Secret; dispatchProof: unknown;
}
/** Implemented only by an authenticated enrolled-device service. There is no
 * renderer/JSON adapter, ambient browser session or default trust provider. */
export interface AutomationRuntimePorts extends AutomationReservationProofPort {
  inventory(ownerUserId: string, signal: AbortSignal): Promise<AutomationWorkspaceSummary[]>;
  /** Current local consent, task ownership and Vault authority are required.
   * Cannot resume a human takeover or manufacture new consent/grants. */
  acquire(context: Readonly<AutomationExecutionContext>, taskId: string, workspaceId: string,
    signal: AbortSignal): Promise<{ identity: AutomationIdentity; taskId: string; controlSessionId: string; expiresAtMs: number }>;
  /** Classify ALL actual effects from the verified target. Unknown business
   * effects must refuse. Model-selected action names are never that proof. */
  prepare(context: Readonly<AutomationExecutionContext>, request: Readonly<AutomationRequest>,
    signal: AbortSignal): Promise<PreparedAutomationOperation>;
  /** Must recheck current control/target/authority immediately before input.
   * Called once, only after the durable reservation marks dispatch. */
  dispatch(reservationId: string, prepared: Readonly<PreparedAutomationOperation>, signal: AbortSignal): Promise<{
    outcome: 'succeeded' | 'no_effect' | 'uncertain'; evidenceIds: string[]; proof: unknown;
  }>;
}
export class AutomationRuntimeError extends Error {}
const refusalMessages = {
  device_offline: 'The automation device is offline. Reconnect the isolated workspace in Josi.',
  local_consent_required: 'The device owner must enable this workspace from its local Josi controls.',
  human_takeover: 'The device owner has control. Resume automation from the local Josi controls when ready.',
  permission_required: 'Current automation permissions do not cover this operation. Ask the administrator to review its exact scope.',
  vault_locked: 'The Vault is unavailable or locked. Unlock and reconcile it through the protected Vault controls.',
  target_changed: 'The observed target changed. Obtain a new authorized observation before planning another action.',
  unclassified_effect: 'Josi cannot establish every effect of this operation. Ask for a supported method or further instructions.',
  budget_exhausted: 'This work reached an approved limit. Ask the administrator for a limit decision before continuing.',
} as const;
/** Adapters can report a precise blocker without forwarding native/provider
 * error text, credentials, screenshot contents or raw policy definitions. */
export class AutomationRuntimeRefusal extends AutomationRuntimeError {
  constructor(readonly code: keyof typeof refusalMessages) {
    super(Object.hasOwn(refusalMessages, code) ? refusalMessages[code] : 'Automation is unavailable.');
  }
}
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const exact = (value: unknown, names: string[]): value is Record<string, unknown> => !!value
  && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key));
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort: () => void = () => {};
  const ended = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new AutomationRuntimeError('The device operation expired or was interrupted.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, ended]); }
  finally { signal.removeEventListener('abort', abort); }
}
export function parseAutomationToolAction(value: unknown): AutomationAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationRuntimeError('Choose a supported exact automation action.');
  const action = value as AutomationAction;
  if (typeof action.kind !== 'string') throw new AutomationRuntimeError('Choose a supported exact automation action.');
  const keys = ['kind'];
  if (action.kind.startsWith('browser.')) {
    if (!('browserProfileId' in action) || !uuid(action.browserProfileId) || !uuid(action.tabId)) throw new AutomationRuntimeError('Use the observed browser profile and tab references.');
    keys.push('browserProfileId', 'tabId');
    if (action.kind === 'browser.navigate') {
      keys.push('url');
      try {
        if (typeof action.url !== 'string' || action.url.length > 8192 || /[\u0000-\u0020\u007f]/u.test(action.url) || refuseMemorySecret(action.url)) throw new Error();
        const url = new URL(action.url);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error();
      } catch { throw new AutomationRuntimeError('Use an exact web destination without credentials.'); }
    } else if (action.kind === 'browser.element') {
      keys.push('elementId', 'action');
      if (!uuid(action.elementId) || !['click', 'fill'].includes(action.action)) throw new AutomationRuntimeError('Use an observed browser element.');
      if (action.action === 'fill') {
        keys.push('valueReference');
        if (!uuid(action.valueReference)) throw new AutomationRuntimeError('Use an authorized value reference; do not send credentials as tool text.');
      }
    } else if (action.kind !== 'browser.observe') throw new AutomationRuntimeError('That browser operation is not supported.');
  } else {
    if (!('appId' in action) || !uuid(action.appId) || !uuid(action.windowId)) throw new AutomationRuntimeError('Use the observed application and window references.');
    keys.push('appId', 'windowId');
    if (action.kind === 'desktop.element') {
      keys.push('elementId', 'action');
      if (!uuid(action.elementId) || !['press', 'focus'].includes(action.action)) throw new AutomationRuntimeError('Use an observed desktop element.');
    } else if (action.kind === 'desktop.pointer') {
      keys.push('x', 'y', 'action');
      if (action.action !== 'click' || !Number.isFinite(action.x) || !Number.isFinite(action.y)
        || action.x < 0 || action.y < 0 || action.x > 32768 || action.y > 32768) throw new AutomationRuntimeError('Choose a bounded position in the observed window.');
    } else if (action.kind !== 'desktop.observe') throw new AutomationRuntimeError('That desktop operation is not supported.');
  }
  if (!exact(action, keys)) throw new AutomationRuntimeError('Unexpected automation action fields.');
  return structuredClone(action);
}
export function automationIntentDigest(request: AutomationRequest): string {
  return cardinalContentDigest(request);
}

/** CE orchestration shared by any connected native transport. This class
 * never receives a raw URL/host command from a renderer, accepts an LLM
 * permission verdict, or treats native input as the user's completed goal. */
export class AutomationRuntime {
  private readonly reservations;
  constructor(private readonly db: Db, key: MasterKey, private readonly ports: AutomationRuntimePorts) {
    if (['inventory', 'acquire', 'prepare', 'dispatch', 'verifyDispatch', 'verifyOutcome']
      .some(name => typeof ports?.[name as keyof AutomationRuntimePorts] !== 'function')) throw new AutomationRuntimeError('The authenticated automation service is incomplete.');
    this.reservations = vaultRecords(db, key).automationReservations(ports);
  }
  async inventory(ownerUserId: string): Promise<AutomationWorkspaceSummary[]> {
    const [owner] = await this.db.query(`select id from users where id=$1 and status='active'`, [ownerUserId]);
    if (!owner) throw new AutomationRuntimeError('The automation owner is unavailable.');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
    let rows: AutomationWorkspaceSummary[];
    try { rows = await bounded(this.ports.inventory(ownerUserId, controller.signal), controller.signal); }
    catch { throw new AutomationRuntimeError('Current automation connections could not be verified.'); }
    finally { clearTimeout(timer); controller.abort(); }
    if (!Array.isArray(rows) || rows.length > 32 || rows.some(row => !exact(row,
      ['identity', 'label', 'isolated', 'browserFamilies', 'computerUse', 'state'])
      || !isAutomationIdentity(row.identity) || row.identity.userId !== ownerUserId || row.isolated !== true
      || typeof row.label !== 'string' || !row.label.trim() || row.label.length > 120 || refuseMemorySecret(row.label)
      || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(row.label)
      || typeof row.computerUse !== 'boolean' || !['ready', 'paused', 'needs_local_consent', 'offline'].includes(row.state)
      || !Array.isArray(row.browserFamilies) || row.browserFamilies.length > 4
      || row.browserFamilies.some(family => !['chrome', 'firefox', 'safari', 'brave'].includes(family))
      || new Set(row.browserFamilies).size !== row.browserFamilies.length)
      || new Set(rows.map(row => row.identity.workspaceId)).size !== rows.length) throw new AutomationRuntimeError('Current workspace discovery could not be verified.');
    return structuredClone(rows);
  }
  async receipt(ownerUserId: string, threadId: string, reservationId: string) {
    const receipt = await this.reservations.read(ownerUserId, reservationId);
    const [task] = receipt ? await this.db.query(`select id from tasks where id=$1 and owner_user_id=$2 and thread_id=$3`,
      [receipt.taskId, ownerUserId, threadId]) : [];
    if (!receipt || !task) throw new AutomationRuntimeError('The automation receipt is unavailable in this conversation.');
    return this.result(receipt, true);
  }
  private async current(context: AutomationExecutionContext, taskId: string, inspection = false) {
    if (![context.ownerUserId, context.threadId, context.turnId, context.leaseToken, taskId].every(uuid)) throw new AutomationRuntimeError('Automation requires the original owned task and a current durable turn.');
    await requireCurrentWorkMemory(this.db, context.ownerUserId, context.workMemoryVersion);
    if (!inspection) await requireReviewedWorkOutcome(this.db, context.ownerUserId, context.threadId);
    const goalId = await requireWorkContinuation(this.db, { ownerUserId: context.ownerUserId, threadId: context.threadId,
      durableTurnId: context.turnId, durableLeaseToken: context.leaseToken });
    const [active] = await this.db.query(`select t.id from tasks t
      join assistant_turns a on a.id=$4 and a.owner_user_id=t.owner_user_id and a.thread_id=t.thread_id
      join sessions s on s.id=a.accepted_session_id and s.user_id=t.owner_user_id
      join threads th on th.id=t.thread_id and th.owner_user_id=t.owner_user_id
      where t.id=$1 and t.owner_user_id=$2 and t.thread_id=$3 and t.state in ('ready','attempting')
        and a.status='running' and a.lease_token=$5 and a.lease_expires_at>clock_timestamp()
        and s.revoked_at is null and s.expires_at>clock_timestamp() and th.status='open'
        and ($6::uuid is null or exists(select 1 from work_goals g, jsonb_array_elements(g.steps) step
          where g.id=$6 and g.owner_user_id=t.owner_user_id and g.thread_id=t.thread_id
            and g.continuation->>'kind'='action' and step->>'id'=g.continuation->>'stepId'
            and step->>'taskId'=t.id::text and step->>'state' in ('pending','working')))`,
      [taskId, context.ownerUserId, context.threadId, context.turnId, context.leaseToken, goalId]);
    if (!active) throw new AutomationRuntimeError('The original task, turn, sign-in or control is no longer current.');
    const goals = await this.db.query<{ id: string; state: string; steps: WorkGoalStep[]; step_id: string | null }>(
      `select id,state,steps,continuation->>'stepId' as step_id from work_goals
        where owner_user_id=$1 and thread_id=$2 and exists(select 1 from jsonb_array_elements(steps) step where step->>'taskId'=$3)
        limit 41`, [context.ownerUserId, context.threadId, taskId]);
    if (goals.length > 40 || goals.some(goal => {
      const step = goal.steps.find(value => value.id === goal.step_id && value.taskId === taskId);
      return !['planning', 'working'].includes(goal.state) || !step || !['pending', 'working'].includes(step.state)
        || !workDependenciesSatisfied(goal.steps, step);
    })) throw new AutomationRuntimeError('Resume the selected unfinished step and resolve its dependencies before automation.');
    if (!inspection) {
      const [uncertain] = await this.db.query(`select 1 from work_goal_effects e join work_goals g on g.id=e.goal_id
        where g.owner_user_id=$1 and g.thread_id=$2 and e.state='started' limit 1`, [context.ownerUserId, context.threadId]);
      if (uncertain) throw new AutomationRuntimeError('Inspect and reconcile this conversation’s uncertain action before another automation effect.');
    }
  }
  async acquire(context: AutomationExecutionContext, taskId: string, workspaceId: string) {
    const bound = Object.freeze(structuredClone(context));
    if (!uuid(workspaceId)) throw new AutomationRuntimeError('Choose a discovered isolated workspace.');
    await this.current(bound, taskId, true);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const result = await bounded(this.ports.acquire(bound, taskId, workspaceId, controller.signal), controller.signal);
      await this.current(bound, taskId, true);
      if (controller.signal.aborted || !exact(result, ['identity', 'taskId', 'controlSessionId', 'expiresAtMs'])
        || !isAutomationIdentity(result.identity) || result.identity.userId !== bound.ownerUserId
        || result.identity.workspaceId !== workspaceId || result.taskId !== taskId || !uuid(result.controlSessionId)
        || !Number.isSafeInteger(result.expiresAtMs) || result.expiresAtMs <= Date.now()
        || result.expiresAtMs > Date.now() + 60_000) throw new AutomationRuntimeError('Workspace control was not confirmed.');
      return { ...structuredClone(result), status: 'connected' as const, executionPermissionGranted: false };
    } catch (error) {
      if (error instanceof AutomationRuntimeRefusal) throw error;
      throw new AutomationRuntimeError('Current workspace control could not be established. Check the isolated device connection and its local consent.');
    } finally { clearTimeout(timer); controller.abort(); }
  }
  async execute(context: AutomationExecutionContext, input: AutomationRequest) {
    const bound = Object.freeze(structuredClone(context));
    if (!exact(input, ['taskId', 'workspaceId', 'observationId', 'action'])
      || ![input.taskId, input.workspaceId, input.observationId].every(uuid)) throw new AutomationRuntimeError('Use an original task, discovered workspace and current observation.');
    const request = Object.freeze({ ...structuredClone(input), action: Object.freeze(parseAutomationToolAction(input.action)) });
    const inspection = ['browser.observe', 'desktop.observe'].includes(request.action.kind);
    await this.current(bound, request.taskId, inspection);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 60_000);
    let expiryTimer: ReturnType<typeof setTimeout> | undefined;
    let reservation: AutomationReservationView | null = null, dispatchMarked = false;
    try {
      const candidate = await bounded(this.ports.prepare(bound, request, controller.signal), controller.signal);
      await this.current(bound, request.taskId, inspection);
      if (controller.signal.aborted || !candidate || !isAutomationIdentity(candidate.identity)
        || candidate.identity.userId !== bound.ownerUserId || candidate.identity.workspaceId !== request.workspaceId
        || candidate.observationId !== request.observationId || candidate.intentDigest !== automationIntentDigest(request)
        || candidate.effectCoverage !== 'verified' || !(candidate.payload instanceof Secret)) throw new AutomationRuntimeError('The actual target and complete action effects could not be verified.');
      const prepared: PreparedAutomationOperation = { ...structuredClone({ ...candidate, payload: undefined }),
        payload: new Secret(candidate.payload.reveal()) };
      if (!Number.isSafeInteger(prepared.expiresAtMs) || prepared.expiresAtMs <= Date.now()
        || prepared.expiresAtMs > Date.now() + 60_000) throw new AutomationRuntimeError('The prepared operation expired.');
      expiryTimer = setTimeout(() => controller.abort(), Math.max(1, prepared.expiresAtMs - Date.now()));
      const reserved = await this.reservations.reserve({ actorUserId: bound.ownerUserId, taskId: request.taskId,
        turnId: bound.turnId, leaseToken: bound.leaseToken, effectIdentity: request.observationId, proposalId: randomUUID(),
        identity: prepared.identity, effects: prepared.effects, effectCoverage: prepared.effectCoverage,
        expected: prepared.expected, expiresAtMs: prepared.expiresAtMs, payload: prepared.payload });
      reservation = reserved.reservation;
      // A prior reservation is evidence to reconcile, never permission to
      // send again. Observation identities are consumed across continuations.
      if (!reserved.created) return this.result(reservation, true);
      await this.current(bound, request.taskId, inspection);
      if (controller.signal.aborted) throw new AutomationRuntimeError('Automation preparation expired.');
      reservation = await this.reservations.markDispatched({ actorUserId: bound.ownerUserId, id: reservation.id,
        turnId: bound.turnId, leaseToken: bound.leaseToken, proof: prepared.dispatchProof });
      dispatchMarked = true;
      await this.current(bound, request.taskId, inspection);
      if (controller.signal.aborted || Date.now() >= prepared.expiresAtMs) throw new AutomationRuntimeError('Automation dispatch expired.');
      const receipt = await bounded(this.ports.dispatch(reservation.id, Object.freeze(prepared), controller.signal), controller.signal);
      reservation = await this.reservations.settle({ actorUserId: bound.ownerUserId, id: reservation.id,
        outcome: receipt.outcome, evidenceIds: receipt.evidenceIds, proof: receipt.proof });
      return this.result(reservation, false);
    } catch (error) {
      if (reservation) {
        try {
          reservation = dispatchMarked
            ? await this.reservations.recordDispatchUncertainty(bound.ownerUserId, reservation.id)
            : await this.reservations.cancelBeforeDispatch(bound.ownerUserId, reservation.id);
        } catch { /* A lost commit/Vault lock leaves the journal to reconcile. Never retry transport. */ }
        if (['succeeded', 'no_effect', 'cancelled'].includes(reservation.state)) return this.result(reservation, false);
        return { ...this.result(reservation, false), status: 'needs_reconciliation' as const };
      }
      if (error instanceof AutomationRuntimeRefusal) throw error;
      throw new AutomationRuntimeError('Automation could not establish current target, permission and task authority. No transport retry was made.');
    } finally { clearTimeout(timer); clearTimeout(expiryTimer); controller.abort(); }
  }
  private result(reservation: AutomationReservationView, replayed: boolean) {
    return { status: reservation.state, reservation, replayed, verificationRequired: true,
      scope: 'operation_only' as const, message: 'This receipt covers an automation operation, not completion of the requested outcome. Observation content requires a separate authorized projection.' };
  }
}
