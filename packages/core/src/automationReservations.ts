// Server-side journal/budget reservations. These are not executable permits.
// Real device authentication, protected consent and dispatch remain separate.
import { createHmac, randomUUID } from 'node:crypto';
import type { AutomationIdentity, AutomationPermissionEvaluation } from '@josi-ce/protocol';
import type { Db } from './db.js';
import { json } from './db.js';
import { appendEvent } from './events.js';
import type { MasterKey } from './masterKey.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { seal, openSealed, Secret } from './sealing.js';
import { isAutomationIdentity, type AutomationPermissionFacts, type AutomationPermissionEffect } from './automationPermissions.js';
import type { VaultAutomationPreview, VaultRecordReference } from './vaultRecords.js';
import { requireWorkContinuation } from './workContinuation.js';
import { workDependenciesSatisfied, type WorkGoalStep } from './workPlan.js';

export type AutomationReservationState = 'reserved' | 'dispatched' | 'succeeded' | 'no_effect' | 'uncertain' | 'cancelled';
export interface AutomationReservationView {
  id: string; taskId: string; effectIdentity: string; proposalId: string; turnEffectId: string;
  state: AutomationReservationState; expiresAt: string; receipt: { outcome: string; evidenceIds: string[] } | null;
  executionEnabled: false;
}
export interface AutomationReservationRequest {
  actorUserId: string; taskId: string; turnId: string; leaseToken: string;
  /** Assigned by the durable work engine, never a model-selected retry key. */
  effectIdentity: string; proposalId: string; identity: AutomationIdentity;
  effects: AutomationPermissionEffect[]; effectCoverage: 'verified' | 'incomplete';
  expected: { permissions: VaultRecordReference; cardinal: VaultRecordReference };
  expiresAtMs: number;
  /** Immutable exact operation/value references from the verified adapter.
   * Never returned by a public journal read, logged or hashed without a key. */
  payload: Secret;
}
export interface AutomationReservationProofPort {
  /** Local cryptographic/receipt checks only; no remote calls in the TX. */
  verifyDispatch(tx: Db, context: AutomationDispatchContext, proof: unknown): Promise<void>;
  verifyOutcome(tx: Db, context: { reservationId: string; planMac: string; identity: AutomationIdentity;
    outcome: 'succeeded' | 'no_effect' | 'uncertain'; evidenceIds: string[] }, proof: unknown): Promise<void>;
}
export interface AutomationDispatchContext {
  reservationId: string; planMac: string; identity: AutomationIdentity; payload: Secret;
  taskId: string; turnId: string; effects: AutomationPermissionEffect[];
  expected: AutomationReservationRequest['expected']; expiresAtMs: number;
}
export interface AutomationReservationTransaction {
  tx: Db; key: MasterKey;
  preview(facts: AutomationPermissionFacts, expected: AutomationReservationRequest['expected']): Promise<VaultAutomationPreview>;
}
export type AutomationReservationBackend = <T>(actorUserId: string, requiresAuthority: boolean, work: (tx: AutomationReservationTransaction) => Promise<T>) => Promise<T>;
export class AutomationReservationError extends Error {}
interface Row {
  id: string; owner_user_id: string; task_id: string; effect_identity: string; proposal_id: string; turn_effect_id: string;
  plan_enc: string; plan_mac: string; state_mac: string; state: AutomationReservationState; expires_at: string; authority_epoch: number | string;
  receipt: AutomationReservationView['receipt'];
}
interface Plan {
  purpose: 'josi-automation-reservation'; schemaVersion: 1; id: string; ownerUserId: string; taskId: string;
  effectIdentity: string; proposalId: string; turnId: string; turnEffectId: string; identity: AutomationIdentity;
  effects: AutomationPermissionEffect[]; effectCoverage: 'verified' | 'incomplete';
  expected: AutomationReservationRequest['expected']; expiresAtMs: number; payload: string;
  charges: AutomationPermissionEvaluation['charges'];
  /** New native dispatches bind the original turn lease. Historical journal
   * reads retain compatibility, but old plans cannot obtain a native permit. */
  leaseToken?: string;
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const publicView = (row: Row): AutomationReservationView => ({ id: row.id, taskId: row.task_id, effectIdentity: row.effect_identity,
  proposalId: row.proposal_id, turnEffectId: row.turn_effect_id, state: row.state, expiresAt: new Date(row.expires_at).toISOString(), receipt: row.receipt, executionEnabled: false });
function mac(key: MasterKey, plan: Plan): string {
  return createHmac('sha256', key.reveal()).update('josi-automation-reservation.1\0').update(JSON.stringify(plan)).digest('hex');
}
function stateMac(key: MasterKey, row: Pick<Row, 'id' | 'plan_mac' | 'state' | 'receipt'>): string {
  return createHmac('sha256', key.reveal()).update('josi-automation-reservation-state.1\0')
    .update(JSON.stringify([row.id, row.plan_mac, row.state, row.receipt ? [row.receipt.outcome, row.receipt.evidenceIds] : null])).digest('hex');
}
function opened(key: MasterKey, row: Row): Plan {
  let plan: Plan;
  try { plan = openSealed<Plan>(key, row.plan_enc); } catch { throw new AutomationReservationError('The saved action is unreadable.'); }
  if (plan?.purpose !== 'josi-automation-reservation' || plan.schemaVersion !== 1 || plan.id !== row.id || plan.ownerUserId !== row.owner_user_id
    || plan.taskId !== row.task_id || plan.effectIdentity !== row.effect_identity || plan.proposalId !== row.proposal_id || plan.turnEffectId !== row.turn_effect_id
    || !isAutomationIdentity(plan.identity) || plan.identity.userId !== row.owner_user_id || typeof plan.payload !== 'string'
    || !Array.isArray(plan.charges) || plan.charges.length > 100 || new Set(plan.charges.map(c => c.ruleId)).size !== plan.charges.length
    || plan.charges.some(c => !uuid(c.ruleId) || c.actions !== 1 || c.bytes !== null && (!Number.isSafeInteger(c.bytes) || c.bytes < 0))
    || plan.expected?.permissions?.epoch !== Number(row.authority_epoch) || plan.expected?.cardinal?.epoch !== Number(row.authority_epoch)
    || new Date(row.expires_at).getTime() !== plan.expiresAtMs
    || mac(key, plan) !== row.plan_mac || stateMac(key, row) !== row.state_mac) throw new AutomationReservationError('The saved action context changed.');
  return plan;
}
async function taskAndTurn(tx: Db, actor: string, taskId: string, turnId: string, leaseToken: string) {
  // Consistent lock order: Vault, user, original task, durable turn, reservation.
  const [task] = await tx.query<{ id: string; thread_id: string | null; state: string; started_ms: string }>(
    `select id,thread_id,state,floor(extract(epoch from created_at)*1000)::text as started_ms
     from tasks where id=$1 and owner_user_id=$2 for update`, [taskId, actor]);
  if (!task || !['ready', 'attempting'].includes(task.state)) throw new AutomationReservationError('The original task is not active.');
  const [turn] = await tx.query(`select id from assistant_turns where id=$1 and owner_user_id=$2 and thread_id=$3
    and status='running' and lease_token=$4 and lease_expires_at>clock_timestamp() for update`, [turnId, actor, task.thread_id, leaseToken]);
  if (!turn) throw new AutomationReservationError('The durable turn lease is unavailable.');
  if (task.thread_id) await requireWorkContinuation(tx, {
    ownerUserId: actor, threadId: task.thread_id, durableTurnId: turnId, durableLeaseToken: leaseToken,
  });
  // A command already queued to the native app must still respect owner
  // Pause/steering and the selected goal step at its final permit boundary.
  const [work] = await tx.query<{ state: string; steps: WorkGoalStep[]; step_id: string; selected: string | null;
    reviewed: boolean }>(`select g.state,g.steps,b.step_id,g.continuation->>'stepId' as selected,
      (g.outcome_revision=g.planned_outcome_revision and not g.plan_review_required) as reviewed
    from automation_work_tasks b join work_goals g on g.id=b.goal_id and g.owner_user_id=b.owner_user_id
    where b.task_id=$1 and b.owner_user_id=$2 for share of g`, [taskId, actor]);
  if (work) {
    const step = work.steps.find(item => item.id === work.step_id && item.taskId === taskId);
    if (!work.reviewed || !['planning', 'working'].includes(work.state) || work.selected !== work.step_id
      || !step || !['pending', 'working'].includes(step.state) || !workDependenciesSatisfied(work.steps, step)) {
      throw new AutomationReservationError('The original goal or selected step changed before native dispatch.');
    }
  }
  const [{ now_ms }] = await tx.query<{ now_ms: string }>('select floor(extract(epoch from clock_timestamp())*1000)::text as now_ms');
  return { task, nowMs: Number(now_ms) };
}
async function usageFor(tx: Db, key: MasterKey, taskId: string, effects: AutomationPermissionEffect[], identity: AutomationIdentity,
  original: { task: { started_ms: string }; nowMs: number }, excludeId?: string): Promise<AutomationPermissionFacts> {
  // Derive consumption from authenticated encrypted plans, not editable SQL
  // counters. A cancelled/uncertain plan still consumes its reserved budget.
  const rows = await tx.query<Row>('select * from automation_reservations where task_id=$1 order by created_at,id limit 1001', [taskId]);
  if (rows.length > 1000 || !excludeId && rows.length === 1000) throw new AutomationReservationError('This task requires an explicit journal-capacity decision.');
  if (effects.some(effect => !['browser.observe', 'computer.observe', 'model.transmit'].includes(effect.action))
    && rows.some(row => row.id !== excludeId && ['dispatched', 'uncertain'].includes(row.state))) {
    throw new AutomationReservationError('Reconcile the original task’s outstanding dispatch before another effect.');
  }
  const totals = new Map<string, { ruleId: string; taskId: string; actions: number; bytes: number | null }>();
  for (const row of rows) for (const charge of opened(key, row).charges) {
    if (row.id === excludeId) continue;
    const previous = totals.get(charge.ruleId) ?? { ruleId: charge.ruleId, taskId, actions: 0, bytes: 0 };
    const bytes = previous.bytes === null || charge.bytes === null ? null : previous.bytes + charge.bytes;
    if (bytes !== null && !Number.isSafeInteger(bytes) || !Number.isSafeInteger(previous.actions + 1)) throw new AutomationReservationError('The task budget cannot be verified.');
    totals.set(charge.ruleId, { ...previous, actions: previous.actions + 1, bytes });
  }
  return { identity, nowMs: original.nowMs, task: { id: taskId, active: true, startedAtMs: Number(original.task.started_ms) },
    effects, effectCoverage: 'verified', usage: [...totals.values()] };
}
export class AutomationReservationStore {
  constructor(private readonly backend: AutomationReservationBackend, private readonly proofs: AutomationReservationProofPort) {}
  async reserve(input: AutomationReservationRequest): Promise<{ created: boolean; reservation: AutomationReservationView }> {
    if (!(input?.payload instanceof Secret) || Buffer.byteLength(input.payload.reveal(), 'utf8') > 64 * 1024) throw new AutomationReservationError('A bounded exact action payload is required.');
    const { payload, ...plain } = input, request = { ...structuredClone(plain), payload: payload.reveal() };
    if (![request.actorUserId, request.taskId, request.turnId, request.leaseToken, request.effectIdentity, request.proposalId].every(uuid)
      || !isAutomationIdentity(request.identity) || request.identity.userId !== request.actorUserId || request.effectCoverage !== 'verified'
      || !Number.isSafeInteger(request.expiresAtMs)) throw new AutomationReservationError('Verified action identity and effects are required.');
    return this.backend(request.actorUserId, true, async ({ tx, key, preview }) => {
      const original = await taskAndTurn(tx, request.actorUserId, request.taskId, request.turnId, request.leaseToken);
      const [existing] = await tx.query<Row>('select * from automation_reservations where task_id=$1 and effect_identity=$2 for update', [request.taskId, request.effectIdentity]);
      if (existing) {
        const plan = opened(key, existing);
        // The stable effect identity survives different turns/processes. A
        // duplicate only returns its record; it is never an instruction to send.
        if (plan.ownerUserId !== request.actorUserId) throw new AutomationReservationError('The saved action is unavailable.');
        const intent = (value: Pick<Plan, 'identity' | 'effects' | 'effectCoverage' | 'payload'>) => cardinalContentDigest({
          identity: value.identity, effects: value.effects, effectCoverage: value.effectCoverage, payload: value.payload,
        });
        if (intent(plan) !== intent(request)) throw new AutomationReservationError('This durable effect is already bound to a different exact action.');
        return { created: false, reservation: publicView(existing) };
      }
      if (request.expiresAtMs <= original.nowMs || request.expiresAtMs > original.nowMs + 60_000) throw new AutomationReservationError('Use an unexpired action lifetime of at most sixty seconds.');
      // Zero baselines are established by the authenticated journal scan, not
      // supplied by a request. Missing/uncertain encrypted history fails above.
      const facts = await usageFor(tx, key, request.taskId, request.effects, request.identity, original);
      const discovery = await preview(facts, request.expected);
      const missing = discovery.permissions?.evaluation?.reasons.filter(r => r.code === 'usage_unavailable' && r.ruleId).map(r => r.ruleId!) ?? [];
      for (const ruleId of new Set(missing)) {
        if (!facts.usage.some(u => u.ruleId === ruleId)) facts.usage.push({ taskId: request.taskId, ruleId, actions: 0, bytes: 0 });
      }
      const checked = await preview(facts, request.expected);
      if (checked.verdict !== 'covered' || !checked.permissions?.evaluation) throw new AutomationReservationError('Current permissions or limits do not cover this action.');
      const id = randomUUID(), turnEffectId = randomUUID(), plan: Plan = { purpose: 'josi-automation-reservation', schemaVersion: 1, id,
        ownerUserId: request.actorUserId, taskId: request.taskId, effectIdentity: request.effectIdentity, proposalId: request.proposalId,
        turnId: request.turnId, turnEffectId, identity: request.identity, effects: request.effects, effectCoverage: request.effectCoverage,
        expected: request.expected, expiresAtMs: request.expiresAtMs, payload: request.payload,
        charges: checked.permissions.evaluation.charges, leaseToken: request.leaseToken };
      if (Buffer.byteLength(JSON.stringify(plan), 'utf8') > 256 * 1024) throw new AutomationReservationError('The verified action plan is too large.');
      const [effect] = await tx.query<{ id: string }>(`insert into assistant_turn_effects(id,turn_id,effect_key,tool_name)
        values($1,$2,$3,'automation.dispatch') on conflict(turn_id,effect_key) do nothing returning id`, [turnEffectId, request.turnId, `automation:${request.effectIdentity}`]);
      if (!effect) throw new AutomationReservationError('The durable action already has an unresolved fence.');
      const planMac = mac(key, plan);
      await tx.query(`insert into automation_reservations(id,owner_user_id,task_id,effect_identity,proposal_id,turn_effect_id,plan_enc,plan_mac,authority_epoch,expires_at,state_mac)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10::double precision/1000),$11)`,
      [id, request.actorUserId, request.taskId, request.effectIdentity, request.proposalId, effect.id, seal(key, plan), planMac,
        request.expected.permissions.epoch, request.expiresAtMs, stateMac(key, { id, plan_mac: planMac, state: 'reserved', receipt: null })]);
      await appendEvent(tx, { actorUserId: request.actorUserId, actor: 'agent', kind: 'automation.reserved', subjectType: 'task', subjectId: request.taskId,
        payload: { reservationId: id, proposalId: request.proposalId, turnEffectId: effect.id, epoch: request.expected.permissions.epoch } });
      const [saved] = await tx.query<Row>('select * from automation_reservations where id=$1', [id]);
      return { created: true, reservation: publicView(saved) };
    });
  }
  async read(actorUserId: string, id: string): Promise<AutomationReservationView | null> {
    if (!uuid(id)) return null;
    return this.backend(actorUserId, false, async ({ tx, key }) => {
      const [row] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2', [id, actorUserId]);
      if (!row) return null; opened(key, row); return publicView(row);
    });
  }
  /** Must commit BEFORE constructing/sending a device command. Losing the
   * response after this transition is uncertain; never claim it a second time.
   * The proof port must verify current enrollment, control and exact payload. */
  async markDispatched(args: { actorUserId: string; id: string; turnId: string; leaseToken: string; proof: unknown }): Promise<AutomationReservationView> {
    const { proof, ...plain } = args, request = structuredClone(plain);
    if (![request.actorUserId, request.id, request.turnId, request.leaseToken].every(uuid)) throw new AutomationReservationError('The action identity is invalid.');
    return this.backend(request.actorUserId, true, async ({ tx, key, preview }) => {
      const [lookup] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2', [request.id, request.actorUserId]);
      if (!lookup) throw new AutomationReservationError('The action is unavailable.');
      const initial = opened(key, lookup);
      if (initial.turnId !== request.turnId || initial.leaseToken && initial.leaseToken !== request.leaseToken) {
        throw new AutomationReservationError('The action belongs to a different durable turn lease.');
      }
      const original = await taskAndTurn(tx, request.actorUserId, initial.taskId, request.turnId, request.leaseToken);
      const [row] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2 for update', [request.id, request.actorUserId]);
      const plan = opened(key, row);
      if (row.state !== 'reserved' || plan.expiresAtMs <= original.nowMs) throw new AutomationReservationError('This action is no longer available for dispatch.');
      const facts = await usageFor(tx, key, plan.taskId, plan.effects, plan.identity, original, row.id);
      // The excluded current reservation supplies the known-zero baselines.
      for (const charge of plan.charges) if (!facts.usage.some(u => u.ruleId === charge.ruleId)) facts.usage.push({ ruleId: charge.ruleId, taskId: plan.taskId, actions: 0, bytes: 0 });
      const checked = await preview(facts, plan.expected);
      if (checked.verdict !== 'covered') throw new AutomationReservationError('The action authority or limits changed before dispatch.');
      const [effect] = await tx.query("select id from assistant_turn_effects where id=$1 and turn_id=$2 and state='started' for update", [row.turn_effect_id, plan.turnId]);
      if (!effect) throw new AutomationReservationError('The durable effect fence changed.');
      if (typeof this.proofs?.verifyDispatch !== 'function') throw new AutomationReservationError('Verified device dispatch is unavailable.');
      await this.proofs.verifyDispatch(tx, this.dispatchContext(row, plan), proof);
      const refreshed = await taskAndTurn(tx, request.actorUserId, initial.taskId, request.turnId, request.leaseToken);
      facts.nowMs = refreshed.nowMs;
      if (plan.expiresAtMs <= refreshed.nowMs || (await preview(facts, plan.expected)).verdict !== 'covered') throw new AutomationReservationError('The action expired or its limits changed during verification.');
      return this.transition(tx, key, row, 'dispatched', null);
    });
  }
  private dispatchContext(row: Row, plan: Plan): AutomationDispatchContext {
    return { reservationId: row.id, planMac: row.plan_mac, identity: structuredClone(plan.identity), payload: new Secret(plan.payload),
      taskId: plan.taskId, turnId: plan.turnId, effects: structuredClone(plan.effects), expected: structuredClone(plan.expected),
      expiresAtMs: plan.expiresAtMs };
  }
  /** The guest's final permit is a SECOND check after durable dispatch. A
   * transport must consume its one-use delivery fence in verifyDispatch,
   * inside this transaction, before returning any permit to the native app.
   * This method never resends an action or changes its recorded outcome. */
  async confirmNativeDispatch(actorUserId: string, id: string, proof: unknown): Promise<AutomationDispatchContext> {
    if (![actorUserId, id].every(uuid)) throw new AutomationReservationError('The native action identity is invalid.');
    return this.backend(actorUserId, true, async ({ tx, key, preview }) => {
      const [lookup] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2', [id, actorUserId]);
      if (!lookup) throw new AutomationReservationError('The native action is unavailable.');
      const initial = opened(key, lookup);
      if (!uuid(initial.leaseToken)) throw new AutomationReservationError('This historical action cannot obtain a native permit.');
      const original = await taskAndTurn(tx, actorUserId, initial.taskId, initial.turnId, initial.leaseToken);
      const [row] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2 for update', [id, actorUserId]);
      const plan = opened(key, row);
      if (row.state !== 'dispatched' || plan.expiresAtMs <= original.nowMs || plan.leaseToken !== initial.leaseToken) {
        throw new AutomationReservationError('The native action is no longer awaiting a permit.');
      }
      const facts = await usageFor(tx, key, plan.taskId, plan.effects, plan.identity, original, row.id);
      for (const charge of plan.charges) if (!facts.usage.some(u => u.ruleId === charge.ruleId)) {
        facts.usage.push({ ruleId: charge.ruleId, taskId: plan.taskId, actions: 0, bytes: 0 });
      }
      if ((await preview(facts, plan.expected)).verdict !== 'covered') throw new AutomationReservationError('Native action permissions or limits changed.');
      const [effect] = await tx.query("select id from assistant_turn_effects where id=$1 and turn_id=$2 and state='started' for update", [row.turn_effect_id, plan.turnId]);
      if (!effect || typeof this.proofs?.verifyDispatch !== 'function') throw new AutomationReservationError('The native effect fence is unavailable.');
      const context = this.dispatchContext(row, plan);
      await this.proofs.verifyDispatch(tx, context, proof);
      const refreshed = await taskAndTurn(tx, actorUserId, plan.taskId, plan.turnId, initial.leaseToken);
      facts.nowMs = refreshed.nowMs;
      if (plan.expiresAtMs <= refreshed.nowMs || (await preview(facts, plan.expected)).verdict !== 'covered') {
        throw new AutomationReservationError('The native action expired during its final permit check.');
      }
      return context;
    });
  }
  /** Authenticated factual outcomes may be recorded after task/turn/policy
   * changes, including recovery inspection. This never restores authority. */
  async settle(args: { actorUserId: string; id: string; outcome: 'succeeded' | 'no_effect' | 'uncertain'; evidenceIds: string[]; proof: unknown }): Promise<AutomationReservationView> {
    const { proof, ...plain } = args, request = structuredClone(plain);
    if (![request.actorUserId, request.id].every(uuid) || !['succeeded', 'no_effect', 'uncertain'].includes(request.outcome)
      || !Array.isArray(request.evidenceIds) || request.evidenceIds.length > 64 || request.evidenceIds.some(e => !uuid(e))
      || request.outcome !== 'uncertain' && !request.evidenceIds.length) throw new AutomationReservationError('Verified outcome evidence is required.');
    return this.backend(request.actorUserId, false, async ({ tx, key }) => {
      const [row] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2 for update', [request.id, request.actorUserId]);
      if (!row) throw new AutomationReservationError('The action is unavailable.');
      const plan = opened(key, row), receipt = { outcome: request.outcome, evidenceIds: request.evidenceIds };
      if (row.state === request.outcome && JSON.stringify(row.receipt?.evidenceIds) === JSON.stringify(receipt.evidenceIds)) return publicView(row);
      if (!['dispatched', 'uncertain'].includes(row.state)) throw new AutomationReservationError('The recorded action cannot accept a different outcome.');
      if (typeof this.proofs?.verifyOutcome !== 'function') throw new AutomationReservationError('Verified device evidence is unavailable.');
      await this.proofs.verifyOutcome(tx, { reservationId: row.id, planMac: row.plan_mac, identity: structuredClone(plan.identity), ...receipt }, proof);
      if (request.outcome !== 'uncertain') await this.finishEffect(tx, row, receipt);
      return this.transition(tx, key, row, request.outcome, receipt);
    });
  }
  async cancelBeforeDispatch(actorUserId: string, id: string): Promise<AutomationReservationView> {
    if (![actorUserId, id].every(uuid)) throw new AutomationReservationError('The action identity is invalid.');
    return this.backend(actorUserId, false, async ({ tx, key }) => {
      const [row] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2 for update', [id, actorUserId]);
      if (!row) throw new AutomationReservationError('The action is unavailable.'); opened(key, row);
      if (row.state === 'cancelled') return publicView(row);
      if (row.state !== 'reserved') throw new AutomationReservationError('A released action requires verified outcome reconciliation.');
      const receipt = { outcome: 'cancelled', evidenceIds: [] };
      await this.finishEffect(tx, row, receipt);
      return this.transition(tx, key, row, 'cancelled', receipt);
    });
  }
  /** Local loss of a dispatch receipt can only make the journal MORE
   * restrictive. No success/no-effect inference and no release of its budget. */
  async recordDispatchUncertainty(actorUserId: string, id: string): Promise<AutomationReservationView> {
    if (!uuid(id)) throw new AutomationReservationError('The action is unavailable.');
    return this.backend(actorUserId, false, async ({ tx, key }) => {
      const [row] = await tx.query<Row>('select * from automation_reservations where id=$1 and owner_user_id=$2 for update', [id, actorUserId]);
      if (!row) throw new AutomationReservationError('The action is unavailable.');
      opened(key, row);
      if (row.state !== 'dispatched') return publicView(row);
      return this.transition(tx, key, row, 'uncertain', { outcome: 'uncertain', evidenceIds: [] });
    });
  }
  private async finishEffect(tx: Db, row: Row, receipt: NonNullable<Row['receipt']>) {
    const changed = await tx.query(`update assistant_turn_effects set state='completed',receipt=$2,completed_at=now()
      where id=$1 and state='started' returning id`, [row.turn_effect_id, json({ automationReservationId: row.id, ...receipt })]);
    if (!changed.length) throw new AutomationReservationError('The durable effect fence changed.');
  }
  private async transition(tx: Db, key: MasterKey, row: Row, state: AutomationReservationState, receipt: Row['receipt']): Promise<AutomationReservationView> {
    const next = { ...row, state, receipt };
    const [saved] = await tx.query<Row>(`update automation_reservations set state=$2,receipt=$3,state_mac=$4,
      dispatched_at=case when $2='dispatched' then now() else dispatched_at end,
      settled_at=case when $2 in ('succeeded','no_effect','cancelled') then now() else null end where id=$1 returning *`,
    [row.id, state, receipt === null ? null : json(receipt), stateMac(key, next)]);
    await appendEvent(tx, { actorUserId: row.owner_user_id, actor: 'agent', kind: `automation.${state}`, subjectType: 'task', subjectId: row.task_id,
      payload: { reservationId: row.id, turnEffectId: row.turn_effect_id } });
    return publicView(saved);
  }
}
