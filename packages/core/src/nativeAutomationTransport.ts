import { createHash, randomUUID } from 'node:crypto';
import type { AutomationModelTarget } from './automationModelTargets.js';
import { validNativeProjectionEnvelope, type NativeProjectionEnvelope } from './nativeProjectionEnvelope.js';
import type { AutomationConsentChallenge, AutomationIdentity } from '@josi-ce/protocol';
import type { Db } from './db.js';
import type { MasterKey } from './masterKey.js';
import { seal, openSealed } from './sealing.js';
import type { VaultRecordReference } from './vaultRecords.js';
import type { AutomationDispatchContext } from './automationReservations.js';
import { sameAutomationIdentity } from './automationTargets.js';

export interface NativeApplicationPin {
  workspaceId: string; applicationId: string; installationRevision: number;
  bundlePath: string; bundleId: string; signingId: string; teamId: string; codeHash: string;
}
export interface NativeControlRenewal {
  identity: AutomationIdentity; storageSessionId: string; authSessionId: string;
  consent: VaultRecordReference; generation: number; leaseUntilMs: number;
  applicationId: string; installationRevision: number;
}
export interface NativeControlState {
  purpose: 'josi-native-control'; schemaVersion: 1;
  identity: AutomationIdentity; storageSessionId: string; authSessionId: string;
  consent: VaultRecordReference; permissions: VaultRecordReference; cardinal: VaultRecordReference;
  guestBootId: string; guestChannelId: string; generation: number;
  application: NativeApplicationPin; targetReference: VaultRecordReference;
  issuedAtMs: number; leaseUntilMs: number; expiresAtMs: number;
  holder: { taskId: string; controlSessionId: string } | null; stopped: boolean;
}
/** Only bounded initial/refreshed AX observation is classified here. Generic
 * clicks have unknown business effects and cannot be manufactured as reads. */
export interface NativeObservationPayload {
  purpose: 'josi-native-observation' | 'josi-native-projection'; schemaVersion: 1;
  storageSessionId: string; consent: VaultRecordReference; targetReference: VaultRecordReference;
  guestBootId: string; guestChannelId: string;
  application: NativeApplicationPin;
  command: {
    id: string; workspaceId: string; appId: string; installationRevision: number;
    taskId: string; sessionId: string; generation: number; expiresAtMs: number;
    operation: 'observe' | 'project'; observationId: string | null; resultObservationId: string; maxOutputBytes: number;
    windowId?: string;
    projection?: { sourceReservationId: string; recipientPublicKey: string; configurationId: string;
      configurationRevision: 1; modelReference: VaultRecordReference };
  };
}
interface NativeDelivery {
  purpose: 'josi-native-delivery'; schemaVersion: 1; id: string; ownerUserId: string; storageSessionId: string;
  state: 'queued' | 'offered' | 'permitted' | 'finished'; planMac: string;
  payload: NativeObservationPayload;
  permit: { commandDigest: string; targetDigest: string } | null;
  projectedBy?: string;
  projection?: NativeProjectionEnvelope | null;
  transmission?: { state: 'sent' | 'finished'; outcome: 'succeeded' | 'no_effect' | 'uncertain'; evidenceId: string };
  result: { outcome: 'succeeded' | 'no_effect' | 'uncertain'; evidenceId: string;
    observationId: string | null; windowId: string | null } | null;
}
export interface NativeTransportContext {
  tx: Db; key: MasterKey; epoch: number;
  requireConsent(identity: AutomationIdentity, sessionId: string, reference: VaultRecordReference): Promise<AutomationConsentChallenge>;
  model(identity: AutomationIdentity, id: string, revision: number): Promise<{ reference: VaultRecordReference; target: AutomationModelTarget }>;
  application(identity: AutomationIdentity, applicationId: string, revision: number): Promise<{
    application: NativeApplicationPin; reference: VaultRecordReference;
  }>;
}
export type NativeTransportBackend = <T>(actor: string, work: (context: NativeTransportContext) => Promise<T>, transaction?: Db) => Promise<T>;
export interface NativeTransportAuthority {
  /** API assembly checks its volatile, hardware-authenticated open session.
   * No worker/model/renderer may implement this with a request-body flag. */
  requireNativeConnection(tx: Db, control: Readonly<NativeControlRenewal>): Promise<void>;
}
export class NativeTransportError extends Error {}
const unavailable = () => new NativeTransportError('The current native automation connection is unavailable.');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const sameRef = (a: VaultRecordReference, b: VaultRecordReference) => a?.recordId === b?.recordId
  && a.version === b.version && a.digest === b.digest && a.epoch === b.epoch;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
function renewal(c: NativeControlState): NativeControlRenewal {
  return { identity: c.identity, storageSessionId: c.storageSessionId, authSessionId: c.authSessionId, consent: c.consent,
    generation: c.generation, leaseUntilMs: c.leaseUntilMs, applicationId: c.application.applicationId,
    installationRevision: c.application.installationRevision };
}
interface ControlRow { storage_session_id: string; owner_user_id: string; workspace_id: string; value_enc: string }
interface DeliveryRow { reservation_id: string; owner_user_id: string; storage_session_id: string; state: NativeDelivery['state']; expires_at: string; value_enc: string }
function openControl(key: MasterKey, row: ControlRow): NativeControlState {
  try {
    const c = openSealed<NativeControlState>(key, row.value_enc);
    if (c.purpose !== 'josi-native-control' || c.schemaVersion !== 1 || c.storageSessionId !== row.storage_session_id
      || c.identity.userId !== row.owner_user_id || c.identity.workspaceId !== row.workspace_id) throw unavailable();
    return c;
  } catch { throw unavailable(); }
}
function openDelivery(key: MasterKey, row: DeliveryRow): NativeDelivery {
  try {
    const d = openSealed<NativeDelivery>(key, row.value_enc);
    if (d.purpose !== 'josi-native-delivery' || d.schemaVersion !== 1 || d.id !== row.reservation_id
      || d.ownerUserId !== row.owner_user_id || d.storageSessionId !== row.storage_session_id || d.state !== row.state
      || d.payload.command.expiresAtMs !== new Date(row.expires_at).getTime()) throw unavailable();
    return d;
  } catch { throw unavailable(); }
}
export class NativeAutomationTransport {
  constructor(private backend: NativeTransportBackend, private authority: NativeTransportAuthority) {}
  private async writeControl(c: NativeTransportContext, value: NativeControlState) {
    await c.tx.query(`insert into automation_native_controls(storage_session_id,owner_user_id,workspace_id,value_enc)
      values($1,$2,$3,$4) on conflict(storage_session_id) do update set value_enc=excluded.value_enc,updated_at=clock_timestamp()`,
    [value.storageSessionId, value.identity.userId, value.identity.workspaceId, seal(c.key, value)]);
  }
  private async control(c: NativeTransportContext, actor: string, id: string, lock = false) {
    const [row] = await c.tx.query<ControlRow>(`select * from automation_native_controls
      where storage_session_id=$1 and owner_user_id=$2 ${lock ? 'for update' : ''}`, [id, actor]);
    if (!row) throw unavailable();
    const value = openControl(c.key, row), now = Date.now();
    if (value.stopped || now < value.issuedAtMs || now >= value.leaseUntilMs || now >= value.expiresAtMs
      || value.leaseUntilMs - value.issuedAtMs > 10_000 || value.consent.epoch !== c.epoch) throw unavailable();
    const proof = await c.requireConsent(value.identity, id, value.consent);
    if (proof.guestBootId !== value.guestBootId || proof.guestChannelId !== value.guestChannelId
      || proof.consentUntilMs !== value.expiresAtMs || !sameRef(proof.permissions, value.permissions)
      || !sameRef(proof.cardinal, value.cardinal)) throw unavailable();
    const [session] = await c.tx.query(`select s.id from sessions s join users u on u.id=s.user_id
      where s.id=$1 and s.user_id=$2 and s.revoked_at is null and s.expires_at>clock_timestamp()
      and u.status='active' and u.role='super_admin' for share of s,u`, [value.authSessionId, actor]);
    if (!session) throw unavailable();
    return value;
  }
  renew(actor: string, input: NativeControlRenewal) {
    const request = structuredClone(input);
    if (![request.storageSessionId, request.authSessionId, request.applicationId].every(uuid)
      || request.identity?.userId !== actor || !integer(request.generation) || !integer(request.leaseUntilMs)) throw unavailable();
    return this.backend(actor, async c => {
      // Serialize absent-row creation as well as renewal.
      await c.tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ['josi-native-control:' + request.storageSessionId]);
      await this.authority.requireNativeConnection(c.tx, request);
      const consent = await c.requireConsent(request.identity, request.storageSessionId, request.consent);
      const target = await c.application(request.identity, request.applicationId, request.installationRevision);
      const now = Date.now();
      if (request.leaseUntilMs <= now || request.leaseUntilMs > now + 10_000 || request.leaseUntilMs > consent.consentUntilMs) throw unavailable();
      const [row] = await c.tx.query<ControlRow>('select * from automation_native_controls where storage_session_id=$1 for update', [request.storageSessionId]);
      const previous = row ? openControl(c.key, row) : null;
      if (previous && (previous.identity.userId !== actor || previous.authSessionId !== request.authSessionId
        || !sameAutomationIdentity(previous.identity, request.identity))) throw unavailable();
      const continuing = !!previous && sameRef(previous.consent, request.consent);
      if (previous && (continuing
        ? previous.stopped || now < previous.issuedAtMs || now >= previous.leaseUntilMs || previous.generation !== request.generation
        : request.consent.recordId !== previous.consent.recordId || request.consent.version <= previous.consent.version
          || consent.guestChannelId === previous.guestChannelId)) throw unavailable();
      const next: NativeControlState = { purpose: 'josi-native-control', schemaVersion: 1,
        identity: request.identity, storageSessionId: request.storageSessionId, authSessionId: request.authSessionId,
        consent: request.consent, permissions: consent.permissions, cardinal: consent.cardinal,
        guestBootId: consent.guestBootId, guestChannelId: consent.guestChannelId, generation: request.generation,
        application: target.application, targetReference: target.reference, issuedAtMs: now, leaseUntilMs: request.leaseUntilMs,
        expiresAtMs: consent.consentUntilMs, holder: continuing ? previous!.holder : null, stopped: false };
      await this.writeControl(c, next);
      return next;
    });
  }
  stop(actor: string, sessionId: string) {
    if (!uuid(sessionId)) throw unavailable();
    return this.backend(actor, async c => {
      const [row] = await c.tx.query<ControlRow>('select * from automation_native_controls where storage_session_id=$1 and owner_user_id=$2 for update', [sessionId, actor]);
      if (!row) return;
      const value = openControl(c.key, row);
      await this.writeControl(c, { ...value, stopped: true, leaseUntilMs: Math.min(value.leaseUntilMs, Date.now()) });
    });
  }
  current(actor: string, workspaceId: string, transaction?: Db) {
    if (!uuid(workspaceId)) throw unavailable();
    return this.backend(actor, async c => {
      const rows = await c.tx.query<ControlRow>(`select * from automation_native_controls where owner_user_id=$1
        and workspace_id=$2 order by updated_at desc limit 2`, [actor, workspaceId]);
      const candidates = rows.filter(row => {
        const v = openControl(c.key, row);
        return !v.stopped && v.leaseUntilMs > Date.now();
      });
      if (candidates.length !== 1) throw unavailable();
      return this.control(c, actor, candidates[0].storage_session_id);
    }, transaction);
  }
  acquire(actor: string, workspaceId: string, taskId: string) {
    if (![workspaceId, taskId].every(uuid)) throw unavailable();
    return this.backend(actor, async c => {
      const value = await this.current(actor, workspaceId, c.tx);
      const control = await this.control(c, actor, value.storageSessionId, true);
      const [task] = await c.tx.query(`select t.id from tasks t join automation_work_tasks b on b.task_id=t.id
        where t.id=$1 and t.owner_user_id=$2 and t.state in ('ready','attempting') and b.workspace_id=$3
        and b.server_id=$4 and b.device_id=$5 for share of t,b`,
      [taskId, actor, workspaceId, control.identity.serverId, control.identity.deviceId]);
      if (!task || control.holder && control.holder.taskId !== taskId) throw unavailable();
      if (!control.holder) {
        control.holder = { taskId, controlSessionId: randomUUID() };
        await this.writeControl(c, control);
      }
      return control;
    });
  }
  private async writeDelivery(c: NativeTransportContext, value: NativeDelivery) {
    const rows = await c.tx.query(`update automation_native_deliveries set state=$2,value_enc=$3,updated_at=clock_timestamp()
      where reservation_id=$1 and owner_user_id=$4 returning reservation_id`,
    [value.id, value.state, seal(c.key, value), value.ownerUserId]);
    if (rows.length !== 1) throw unavailable();
  }
  private payload(context: AutomationDispatchContext): NativeObservationPayload {
    try {
      const p = JSON.parse(context.payload.reveal()) as NativeObservationPayload, command = p.command;
      if (!exact(p, ['purpose', 'schemaVersion', 'storageSessionId', 'consent', 'targetReference', 'guestBootId', 'guestChannelId', 'application', 'command'])
        || !['josi-native-observation', 'josi-native-projection'].includes(p.purpose) || p.schemaVersion !== 1
        || !exact(command, ['id', 'workspaceId', 'appId', 'installationRevision', 'taskId', 'sessionId', 'generation',
          'expiresAtMs', 'operation', 'observationId', 'resultObservationId', 'maxOutputBytes',
          ...(p.purpose === 'josi-native-projection' ? ['windowId', 'projection'] : [])])
        || ![p.storageSessionId, p.guestBootId, p.guestChannelId, command.id, command.workspaceId, command.appId,
          command.taskId, command.sessionId, command.resultObservationId].every(uuid)
        || command.observationId !== null && !uuid(command.observationId) || command.operation !== (p.purpose === 'josi-native-projection' ? 'project' : 'observe')
        || command.taskId !== context.taskId || command.workspaceId !== context.identity.workspaceId
        || command.expiresAtMs !== context.expiresAtMs || !integer(command.generation)
        || !integer(command.maxOutputBytes) || command.maxOutputBytes < 1024 || command.maxOutputBytes > 64 * 1024
        || context.effects.length !== 1 || context.effects[0].bytes !== command.maxOutputBytes) throw unavailable();
      const effect = context.effects[0], projection = command.projection;
      if (command.operation === 'observe') {
        if (effect.action !== 'computer.observe' || Object.keys(effect.target).sort().join(',') !== 'applicationId,installationRevision,kind'
          || effect.target.kind !== 'application' || effect.target.applicationId !== command.appId
          || effect.target.installationRevision !== command.installationRevision) throw unavailable();
      } else if (!projection || !exact(projection, ['sourceReservationId', 'recipientPublicKey', 'configurationId', 'configurationRevision', 'modelReference'])
        || ![projection.sourceReservationId, projection.configurationId, command.observationId, command.windowId].every(uuid)
        || projection.configurationRevision !== 1 || typeof projection.recipientPublicKey !== 'string'
        || !/^[A-Za-z0-9+/]{43}=$/.test(projection.recipientPublicKey)
        || effect.action !== 'model.transmit' || Object.keys(effect.target).sort().join(',') !== 'configurationId,configurationRevision,kind'
        || effect.target.kind !== 'model' || effect.target.configurationId !== projection.configurationId
        || effect.target.configurationRevision !== projection.configurationRevision) throw unavailable();
      return p;
    } catch { throw unavailable(); }
  }
  private async bound(c: NativeTransportContext, context: AutomationDispatchContext) {
    const p = this.payload(context), control = await this.control(c, context.identity.userId, p.storageSessionId);
    const target = await c.application(context.identity, p.command.appId, p.command.installationRevision);
    if (!sameAutomationIdentity(context.identity, control.identity) || !sameRef(p.consent, control.consent)
      || !sameRef(context.expected.permissions, control.permissions) || !sameRef(context.expected.cardinal, control.cardinal)
      || !sameRef(p.targetReference, target.reference) || JSON.stringify(p.application) !== JSON.stringify(target.application)
      || JSON.stringify(p.application) !== JSON.stringify(control.application)
      || p.guestBootId !== control.guestBootId || p.guestChannelId !== control.guestChannelId
      || p.command.generation !== control.generation || p.command.expiresAtMs > control.leaseUntilMs
      || control.holder?.taskId !== p.command.taskId || control.holder.controlSessionId !== p.command.sessionId) throw unavailable();
    if (p.command.operation === 'project') {
      const projection = p.command.projection!;
      const model = await c.model(context.identity, projection.configurationId, projection.configurationRevision);
      const source = await this.result(context.identity.userId, projection.sourceReservationId, c.tx);
      if (!sameRef(model.reference, projection.modelReference) || model.target.candidate.role !== 'primary'
        || !source || source.payload.command.operation !== 'observe' || source.result?.outcome !== 'succeeded'
        || source.result.observationId !== p.command.observationId || source.result.windowId !== p.command.windowId
        || source.storageSessionId !== p.storageSessionId || source.payload.command.taskId !== context.taskId
        || source.payload.command.sessionId !== p.command.sessionId || source.payload.command.generation !== p.command.generation
        || !sameRef(source.payload.consent, p.consent) || JSON.stringify(source.payload.application) !== JSON.stringify(p.application)) throw unavailable();
    }
    return { p, control };
  }
  verifyPrepared(tx: Db, context: AutomationDispatchContext, proof: unknown) {
    if (!exact(proof, ['phase', 'commandId']) || proof.phase !== 'prepared') throw unavailable();
    return this.backend(context.identity.userId, async c => {
      const { p } = await this.bound(c, context);
      if (proof.commandId !== p.command.id) throw unavailable();
    }, tx);
  }
  enqueue(tx: Db, context: AutomationDispatchContext, proof: unknown) {
    if (!exact(proof, ['phase', 'commandId']) || proof.phase !== 'queue') throw unavailable();
    return this.backend(context.identity.userId, async c => {
      const { p, control } = await this.bound(c, context);
      if (proof.commandId !== p.command.id) throw unavailable();
      await c.tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ['josi-native-delivery:' + p.storageSessionId]);
      const pending = await c.tx.query(`select reservation_id from automation_native_deliveries
        where storage_session_id=$1 and state<>'finished' and expires_at>clock_timestamp() limit 1`, [p.storageSessionId]);
      if (pending.length) throw new NativeTransportError('This desktop already has an outstanding command.');
      if (p.command.operation === 'project') {
        const [sourceRow] = await c.tx.query<DeliveryRow>('select * from automation_native_deliveries where reservation_id=$1 and owner_user_id=$2 for update',
          [p.command.projection!.sourceReservationId, context.identity.userId]);
        if (!sourceRow) throw unavailable();
        const source = openDelivery(c.key, sourceRow);
        if (source.projectedBy) throw new NativeTransportError('This capture already has a projection attempt. It cannot be exported again.');
        source.projectedBy = context.reservationId; await this.writeDelivery(c, source);
      }
      const value: NativeDelivery = { purpose: 'josi-native-delivery', schemaVersion: 1, id: context.reservationId,
        ownerUserId: context.identity.userId, storageSessionId: control.storageSessionId, state: 'queued',
        planMac: context.planMac, payload: p, permit: null, result: null };
      const rows = await c.tx.query(`insert into automation_native_deliveries
        (reservation_id,owner_user_id,storage_session_id,state,expires_at,value_enc)
        values($1,$2,$3,'queued',to_timestamp($4/1000.0),$5) on conflict(reservation_id) do nothing returning reservation_id`,
      [value.id, value.ownerUserId, value.storageSessionId, p.command.expiresAtMs, seal(c.key, value)]);
      if (rows.length !== 1) throw new NativeTransportError('This action already has a delivery record. It cannot be sent again.');
    }, tx);
  }
  /** Commit the offered fence before returning bytes. A lost response is
   * uncertain; neither reconnect nor polling can put this row back in queue. */
  take(actor: string, sessionId: string) {
    if (!uuid(sessionId)) throw unavailable();
    return this.backend(actor, async c => {
      await c.tx.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ['josi-native-delivery:' + sessionId]);
      const control = await this.control(c, actor, sessionId);
      await this.authority.requireNativeConnection(c.tx, renewal(control));
      const rows = await c.tx.query<DeliveryRow>(`select * from automation_native_deliveries where storage_session_id=$1
        and owner_user_id=$2 and state<>'finished' and expires_at>clock_timestamp() order by created_at limit 2 for update`,
      [sessionId, actor]);
      if (!rows.length) return null;
      if (rows.length !== 1) throw unavailable();
      const d = openDelivery(c.key, rows[0]);
      if (d.state !== 'queued') return null;
      if (d.payload.command.expiresAtMs > control.leaseUntilMs || !sameRef(d.payload.consent, control.consent)
        || d.payload.command.generation !== control.generation || d.payload.command.taskId !== control.holder?.taskId
        || d.payload.command.sessionId !== control.holder.controlSessionId) throw unavailable();
      d.state = 'offered'; await this.writeDelivery(c, d);
      return { reservationId: d.id, command: d.payload.command, commandJSON: JSON.stringify(d.payload.command), application: d.payload.application };
    });
  }
  /** Called only through confirmNativeDispatch so task/turn, policy, budgets,
   * current target and delivery consumption share the original Vault TX. */
  permit(tx: Db, context: AutomationDispatchContext, sessionId: string, query: unknown) {
    return this.backend(context.identity.userId, async c => {
      const { p, control } = await this.bound(c, context);
      if (control.storageSessionId !== sessionId) throw unavailable();
      await this.authority.requireNativeConnection(c.tx, renewal(control));
      const [row] = await c.tx.query<DeliveryRow>('select * from automation_native_deliveries where reservation_id=$1 and owner_user_id=$2 for update',
        [context.reservationId, context.identity.userId]);
      if (!row) throw unavailable();
      const d = openDelivery(c.key, row);
      if (d.state !== 'offered' || d.planMac !== context.planMac || JSON.stringify(d.payload) !== JSON.stringify(p)
        || !exact(query, ['kind', 'commandId', 'reservationId', 'commandDigest', 'target', 'targetDigest', 'consentDigest'])
        || query.kind !== 'authorize' || query.commandId !== p.command.id || query.reservationId !== d.id
        || query.consentDigest !== p.consent.digest || query.commandDigest !== hash(JSON.stringify(p.command)) || typeof query.target !== 'string'
        || Buffer.byteLength(query.target) > 4096 || query.targetDigest !== hash(query.target)) throw unavailable();
      // The native app forwards these exact reserved command bytes after
      // decoding and comparing them with the structured command.
      let target: unknown;
      try { target = JSON.parse(query.target); } catch { throw unavailable(); }
      if (!exact(target, ['processId', 'launchedAt', 'bundleId', 'executablePath', 'windowTitle', 'bounds'])
        || !integer(target.processId) || target.processId < 1 || target.processId > 0x7fffffff
        || typeof target.launchedAt !== 'number' || !Number.isFinite(target.launchedAt) || target.launchedAt < 0 || target.launchedAt > Date.now()
        || target.bundleId !== p.application.bundleId || target.windowTitle !== ''
        || typeof target.executablePath !== 'string' || target.executablePath.length > 2048
        || !target.executablePath.startsWith(p.application.bundlePath + '/') || target.executablePath.split('/').some(s => s === '.' || s === '..')
        || !Array.isArray(target.bounds) || target.bounds.length !== 2
        || target.bounds.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(n => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 131072))
        || target.bounds[1][0] <= 0 || target.bounds[1][1] <= 0) throw unavailable();
      d.state = 'permitted'; d.permit = { commandDigest: query.commandDigest, targetDigest: query.targetDigest as string };
      await this.writeDelivery(c, d);
    }, tx);
  }
  report(actor: string, sessionId: string, receipt: unknown) {
    const projected = (receipt as { outcome?: unknown })?.outcome === 'projected';
    if (!exact(receipt, ['kind', 'commandId', 'reservationId', 'outcome', 'verificationRequired', 'observationId', 'windowId', ...(projected ? ['projection'] : [])])
      || receipt.kind !== 'result' || receipt.verificationRequired !== 'yes' || !uuid(receipt.reservationId)) throw unavailable();
    return this.backend(actor, async c => {
      const control = await this.control(c, actor, sessionId);
      await this.authority.requireNativeConnection(c.tx, renewal(control));
      const [row] = await c.tx.query<DeliveryRow>('select * from automation_native_deliveries where reservation_id=$1 and owner_user_id=$2 for update',
        [receipt.reservationId, actor]);
      if (!row) throw unavailable();
      const d = openDelivery(c.key, row);
      if (!['offered', 'permitted'].includes(d.state) || d.storageSessionId !== sessionId
        || receipt.commandId !== d.payload.command.id || !sameRef(d.payload.consent, control.consent)
        || Date.now() >= d.payload.command.expiresAtMs) throw unavailable();
      let result: NonNullable<NativeDelivery['result']>;
      if (receipt.outcome === 'observed' || projected) {
        if (projected !== (d.payload.command.operation === 'project')) throw unavailable();
        if (projected) {
          if (!validNativeProjectionEnvelope(receipt.projection) || receipt.windowId !== d.payload.command.windowId) throw unavailable();
          d.projection = receipt.projection;
        }
        if (d.state !== 'permitted' || receipt.observationId !== d.payload.command.resultObservationId || !uuid(receipt.windowId)) throw unavailable();
        result = { outcome: 'succeeded', evidenceId: randomUUID(), observationId: receipt.observationId as string, windowId: receipt.windowId };
      } else {
        if (!['denied', 'uncertain'].includes(String(receipt.outcome)) || receipt.observationId !== '' || receipt.windowId !== '') throw unavailable();
        result = { outcome: d.state === 'offered' && receipt.outcome === 'denied' ? 'no_effect' : 'uncertain',
          evidenceId: randomUUID(), observationId: null, windowId: null };
      }
      d.state = 'finished'; d.result = result;
      await this.writeDelivery(c, d);
      return { recorded: true };
    });
  }
  result(actor: string, reservationId: string, transaction?: Db) {
    if (!uuid(reservationId)) throw unavailable();
    return this.backend(actor, async c => {
      const [row] = await c.tx.query<DeliveryRow>('select * from automation_native_deliveries where reservation_id=$1 and owner_user_id=$2', [reservationId, actor]);
      if (!row) throw unavailable();
      const value = openDelivery(c.key, row);
      return value.state === 'finished' ? value : null;
    }, transaction);
  }
  /** One final local fence immediately before the pinned provider request. */
  sendProjection(tx: Db, context: AutomationDispatchContext, proof: unknown) {
    if (!exact(proof, ['phase', 'reservationId']) || proof.phase !== 'model-send' || proof.reservationId !== context.reservationId) throw unavailable();
    return this.backend(context.identity.userId, async c => {
      const { p } = await this.bound(c, context);
      const [row] = await c.tx.query<DeliveryRow>('select * from automation_native_deliveries where reservation_id=$1 and owner_user_id=$2 for update', [context.reservationId, context.identity.userId]);
      if (!row) throw unavailable();
      const d = openDelivery(c.key, row);
      if (p.command.operation !== 'project' || d.state !== 'finished' || d.planMac !== context.planMac
        || JSON.stringify(d.payload) !== JSON.stringify(p) || d.result?.outcome !== 'succeeded' || !d.projection || d.transmission) throw unavailable();
      d.transmission = { state: 'sent', outcome: 'uncertain', evidenceId: randomUUID() };
      d.projection = null; // No replay payload after the provider fence commits.
      await this.writeDelivery(c, d);
    }, tx);
  }
  finishProjection(actor: string, reservationId: string, outcome: 'succeeded' | 'no_effect' | 'uncertain') {
    return this.backend(actor, async c => {
      const [row] = await c.tx.query<DeliveryRow>('select * from automation_native_deliveries where reservation_id=$1 and owner_user_id=$2 for update', [reservationId, actor]);
      if (!row) throw unavailable();
      const d = openDelivery(c.key, row);
      if (d.payload.command.operation !== 'project' || d.state !== 'finished'
        || d.transmission?.state === 'finished' || (outcome === 'no_effect' ? !!d.transmission : d.transmission?.state !== 'sent')) throw unavailable();
      d.transmission = { state: 'finished', outcome, evidenceId: randomUUID() }; d.projection = null;
      await this.writeDelivery(c, d);
      return d.transmission;
    });
  }
  verifyOutcome(tx: Db, context: { reservationId: string; planMac: string; identity: AutomationIdentity;
    outcome: 'succeeded' | 'no_effect' | 'uncertain'; evidenceIds: string[] }, proof: unknown) {
    if (!exact(proof, ['phase', 'reservationId']) || !['native-result', 'model-result'].includes(String(proof.phase)) || proof.reservationId !== context.reservationId) throw unavailable();
    return this.backend(context.identity.userId, async c => {
      const d = await this.result(context.identity.userId, context.reservationId, c.tx);
      const result = d?.payload.command.operation === 'project' ? d.transmission?.state === 'finished' && proof.phase === 'model-result' ? d.transmission : null
        : proof.phase === 'native-result' ? d?.result : null;
      if (!d || !result || d.planMac !== context.planMac || result.outcome !== context.outcome
        || context.evidenceIds.length !== 1 || context.evidenceIds[0] !== result.evidenceId) throw unavailable();
      const [row] = await c.tx.query<ControlRow>('select * from automation_native_controls where storage_session_id=$1 and owner_user_id=$2',
        [d.storageSessionId, context.identity.userId]);
      if (!row || !sameAutomationIdentity(openControl(c.key, row).identity, context.identity)) throw unavailable();
    }, tx);
  }
}
