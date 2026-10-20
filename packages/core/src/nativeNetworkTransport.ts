import { isIP } from 'node:net';
import type { Db } from './db.js';
import type { AutomationDispatchContext } from './automationReservations.js';
import type { NativeControlState, NativeTransportBackend } from './nativeAutomationTransport.js';
import type { VaultRecordReference } from './vaultRecords.js';
import { exactBrowserOrigin } from './nativeBrowserObservation.js';
import { sameAutomationIdentity } from './automationTargets.js';
import { cardinalContentDigest } from './cardinalRules.js';
import { seal, openSealed } from './sealing.js';

export interface NativeNetworkRequest {
  id: string; workspaceId: string; taskId: string; origin: string;
  networkClass: 'public' | 'private' | 'loopback'; maximumBytes: number; expiresAtMs: number;
}
/** Produced by the trusted task adapter, never by the guest or model. Network
 * authority alone does not authorize browser navigation, input or inspection. */
export interface NativeNetworkPayload {
  purpose: 'josi-native-network'; schemaVersion: 1; storageSessionId: string;
  consent: VaultRecordReference; targetReference: VaultRecordReference;
  guestBootId: string; guestChannelId: string; controlSessionId: string; generation: number;
  application: NativeControlState['application']; browser: NonNullable<NativeControlState['browser']>;
  request: NativeNetworkRequest;
}
interface Destination {
  hostname: string; port: number; addresses: string[]; networkClass: NativeNetworkRequest['networkClass'];
}
interface Query {
  kind: 'network-permit'; reservationId: string; request: NativeNetworkRequest;
  phase: 'lookup' | 'resolved' | 'connect' | 'transfer' | 'current';
  destination: Destination | null; address: string | null;
  direction: 'upload' | 'download' | null; maximumBytes: number | null;
}
interface NetworkState {
  purpose: 'josi-native-network-state'; schemaVersion: 1; reservationId: string; requestId: string;
  ownerUserId: string; storageSessionId: string; planMac: string; expiresAtMs: number;
  state: 'lookup' | 'resolved' | 'connected'; destination: Destination | null;
}
interface Row {
  reservation_id: string; request_id: string; owner_user_id: string; storage_session_id: string;
  expires_at: string; value_enc: string;
}
const uuid = (v: unknown): v is string => typeof v === 'string'
  && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const equal = (a: unknown, b: unknown) => cardinalContentDigest(a) === cardinalContentDigest(b);
const sameRef = (a: VaultRecordReference, b: VaultRecordReference) => a?.recordId === b?.recordId
  && a.version === b.version && a.digest === b.digest && a.epoch === b.epoch;
export class NativeNetworkTransportError extends Error {
  constructor() { super('This task’s current native network permission is unavailable.'); }
}
const denied = () => new NativeNetworkTransportError();

export class NativeNetworkTransport {
  constructor(private backend: NativeTransportBackend,
    private current: (tx: Db, owner: string, workspace: string) => Promise<NativeControlState>) {}

  private payload(context: AutomationDispatchContext): NativeNetworkPayload {
    try {
      const p = JSON.parse(context.payload.reveal()) as NativeNetworkPayload, r = p.request;
      if (!exact(p, ['purpose', 'schemaVersion', 'storageSessionId', 'consent', 'targetReference', 'guestBootId',
        'guestChannelId', 'controlSessionId', 'generation', 'application', 'browser', 'request'])
        || p.purpose !== 'josi-native-network' || p.schemaVersion !== 1
        || ![p.storageSessionId, p.guestBootId, p.guestChannelId, p.controlSessionId].every(uuid)
        || !integer(p.generation) || !exact(r, ['id', 'workspaceId', 'taskId', 'origin', 'networkClass', 'maximumBytes', 'expiresAtMs'])
        || ![r.id, r.workspaceId, r.taskId].every(uuid) || !exactBrowserOrigin(r.origin)
        || !['public', 'private', 'loopback'].includes(r.networkClass) || !integer(r.maximumBytes)
        || r.maximumBytes < 1 || r.maximumBytes > 16_777_216 || !integer(r.expiresAtMs)
        || r.taskId !== context.taskId || r.workspaceId !== context.identity.workspaceId
        || r.expiresAtMs !== context.expiresAtMs || context.effects.length !== 1) throw denied();
      const effect = context.effects[0];
      if (effect.action !== 'network.connect' || effect.bytes !== r.maximumBytes
        || effect.target.kind !== 'network' || Object.keys(effect.target).sort().join(',') !== 'kind,networkClass,origin'
        || effect.target.origin !== r.origin || effect.target.networkClass !== r.networkClass) throw denied();
      return p;
    } catch { throw denied(); }
  }
  private async bound(tx: Db, context: AutomationDispatchContext) {
    const p = this.payload(context), c = await this.current(tx, context.identity.userId, p.request.workspaceId);
    if (!sameAutomationIdentity(context.identity, c.identity) || p.storageSessionId !== c.storageSessionId
      || !sameRef(p.consent, c.consent) || !sameRef(p.targetReference, c.targetReference)
      || !sameRef(context.expected.permissions, c.permissions) || !sameRef(context.expected.cardinal, c.cardinal)
      || p.guestBootId !== c.guestBootId || p.guestChannelId !== c.guestChannelId
      || p.controlSessionId !== c.holder?.controlSessionId || p.request.taskId !== c.holder.taskId
      || p.generation !== c.generation || !equal(p.application, c.application) || !c.browser || !equal(p.browser, c.browser)
      || p.request.expiresAtMs > c.leaseUntilMs || Date.now() >= p.request.expiresAtMs
      || p.request.expiresAtMs > Date.now() + 10_000) throw denied();
    return p;
  }
  /** The production task producer is not registered yet. Its dispatch hook
   * must call this before marking the original durable reservation dispatched. */
  async verifyPrepared(tx: Db, context: AutomationDispatchContext, proof: unknown) {
    if (!exact(proof, ['phase', 'requestId']) || proof.phase !== 'network-prepared') throw denied();
    const p = await this.bound(tx, context);
    if (proof.requestId !== p.request.id) throw denied();
  }
  /** Runs INSIDE confirmNativeDispatch's current Vault/task/turn transaction.
   * Lookup, resolution and connection each consume a distinct durable stage.
   * Transfer/current only revalidate the same reservation, never refund or
   * allocate another budget. Payload accounting is also enforced in the host. */
  permit(tx: Db, context: AutomationDispatchContext, sessionId: string, input: unknown) {
    if (!exact(input, ['kind', 'reservationId', 'request', 'phase', 'destination', 'address', 'direction', 'maximumBytes'])
      || input.kind !== 'network-permit' || input.reservationId !== context.reservationId
      || !['lookup', 'resolved', 'connect', 'transfer', 'current'].includes(String(input.phase))) throw denied();
    const q = structuredClone(input) as unknown as Query;
    return this.backend(context.identity.userId, async c => {
      const p = await this.bound(c.tx, context);
      if (sessionId !== p.storageSessionId || !equal(q.request, p.request)) throw denied();
      const [row] = await c.tx.query<Row>(`select * from automation_native_networks
        where reservation_id=$1 and owner_user_id=$2 for update`, [context.reservationId, context.identity.userId]);
      if (q.phase === 'lookup') {
        if (row || q.destination !== null || q.address !== null || q.direction !== null || q.maximumBytes !== null) throw denied();
        const value: NetworkState = { purpose: 'josi-native-network-state', schemaVersion: 1,
          reservationId: context.reservationId, requestId: p.request.id, ownerUserId: context.identity.userId,
          storageSessionId: sessionId, planMac: context.planMac, expiresAtMs: context.expiresAtMs, state: 'lookup', destination: null };
        await c.tx.query(`insert into automation_native_networks
          (reservation_id,request_id,owner_user_id,storage_session_id,expires_at,value_enc)
          values($1,$2,$3,$4,to_timestamp($5::double precision/1000),$6)`,
        [value.reservationId, value.requestId, value.ownerUserId, sessionId, value.expiresAtMs, seal(c.key, value)]);
        return;
      }
      if (!row) throw denied();
      let saved: NetworkState;
      try { saved = openSealed<NetworkState>(c.key, row.value_enc); } catch { throw denied(); }
      if (saved.purpose !== 'josi-native-network-state' || saved.schemaVersion !== 1
        || saved.reservationId !== row.reservation_id || saved.reservationId !== context.reservationId
        || saved.requestId !== row.request_id || saved.requestId !== p.request.id
        || saved.ownerUserId !== row.owner_user_id || saved.ownerUserId !== context.identity.userId
        || saved.storageSessionId !== row.storage_session_id || saved.storageSessionId !== sessionId
        || saved.planMac !== context.planMac || saved.expiresAtMs !== context.expiresAtMs
        || saved.expiresAtMs !== new Date(row.expires_at).getTime()) throw denied();
      const d = q.destination, url = new URL(p.request.origin);
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      if (!exact(d, ['hostname', 'port', 'addresses', 'networkClass']) || d.hostname !== hostname
        || d.port !== Number(url.port || (url.protocol === 'https:' ? 443 : 80)) || d.networkClass !== p.request.networkClass
        || !Array.isArray(d.addresses) || d.addresses.length < 1 || d.addresses.length > 16
        || new Set(d.addresses).size !== d.addresses.length
        || d.addresses.some(a => typeof a !== 'string' || a.includes('%') || a.length > 45 || !isIP(a))) throw denied();
      // Locality is classified by the signed native resolver; this endpoint
      // pins its report, and never opens or resolves an address on the server.
      if (q.phase === 'resolved') {
        if (saved.state !== 'lookup' || q.address !== null || q.direction !== null || q.maximumBytes !== null) throw denied();
        saved.destination = d; saved.state = 'resolved';
      } else {
        if (!equal(saved.destination, d) || q.address !== d.addresses[0]) throw denied();
        if (q.phase === 'connect') {
          if (saved.state !== 'resolved' || q.direction !== null || q.maximumBytes !== null) throw denied();
          saved.state = 'connected';
        } else {
          if (saved.state !== 'connected') throw denied();
          if (q.phase === 'current') {
            if (q.direction !== null || q.maximumBytes !== null) throw denied();
          } else if (!['upload', 'download'].includes(String(q.direction)) || !integer(q.maximumBytes)
            || q.maximumBytes < 1 || q.maximumBytes > Math.min(32_768, p.request.maximumBytes)) throw denied();
        }
      }
      if (q.phase === 'resolved' || q.phase === 'connect') {
        await c.tx.query('update automation_native_networks set value_enc=$2 where reservation_id=$1',
          [context.reservationId, seal(c.key, saved)]);
      }
    }, tx);
  }
}
