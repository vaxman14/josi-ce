import { randomUUID } from 'node:crypto';
import type { AutomationAction, AutomationIdentity, VaultAuthorityReference } from '@josi-ce/protocol';

/** Only references to canonical Vault authority. No secret or copied policy. */
export interface DeviceAuthority {
  consent: VaultAuthorityReference; permissions: VaultAuthorityReference; cardinal: VaultAuthorityReference;
}
export interface DeviceConsent {
  identity: AutomationIdentity; authority: DeviceAuthority; expiresAtMs: number;
}
export interface VerifiedDeviceCommand {
  id: string; reservationId: string; identity: AutomationIdentity; bootId: string; channelId: string;
  taskId: string; generation: number; sequence: number; authority: DeviceAuthority; expiresAtMs: number;
  observation: { id: string; targetId: string; targetRevision: number; generation: number };
  action: AutomationAction;
}
export interface DeviceDispatchReceipt {
  commandId: string | null; reservationId: string | null;
  outcome: 'denied' | 'succeeded' | 'failed' | 'uncertain'; code: string; evidenceIds: string[];
}
export interface DeviceControlState {
  bootId: string; generation: number; consented: boolean; connected: boolean;
  holder: 'none' | 'agent' | 'human'; taskId: string | null; busy: boolean; paused: boolean; uncertainActions: number;
}
export interface DeviceControlPorts {
  /** Protected LOCAL control only. Verify fresh owner intent and canonical
   * Vault references. A server packet/JSON `human:true` cannot implement this.
   * This port must never be exposed to the automation transport or renderer. */
  verifyLocalConsent(proof: unknown): Promise<DeviceConsent | null>;
  /** Authenticate the outbound channel's exact peer and current authority.
   * Local consent must already exist; this cannot enable or widen it. */
  verifyChannel(proof: unknown, consent: DeviceConsent, bootId: string): Promise<{ channelId: string; authority: DeviceAuthority; expiresAtMs: number } | null>;
  /** Authenticate the FULL immutable command, current policies/device consent
   * and durable one-use budget/effect reservation. No LLM verdict substitutes.
   * The gate adds local liveness/focus/replay checks after this async work. */
  verifyCommand(packet: unknown, state: Readonly<DeviceControlState>, signal: AbortSignal): Promise<VerifiedDeviceCommand | null>;
  /** Verify durable reconciliation of EACH uncertain reservation, bound to
   * the current peer/authority. A new command or model assertion is not proof. */
  verifyReconciliation(proof: unknown, context: { identity: AutomationIdentity; bootId: string; channelId: string;
    authority: DeviceAuthority; reservationIds: string[] }): Promise<boolean>;
  /** Local adapter observation, not a remote asserted target. The adapter
   * must update revision after navigation, focus/target or relevant state changes. */
  currentObservation(): VerifiedDeviceCommand['observation'] | null;
  /** Trusted adapter only. Invoke the native operation synchronously here, or
   * recheck the signal/target immediately before each native input if awaiting.
   * Abort is not rollback. Never queue input beyond this single command. */
  invoke(command: Readonly<VerifiedDeviceCommand>, signal: AbortSignal): Promise<{ outcome: 'succeeded' | 'failed' | 'uncertain'; evidenceIds: string[] }>;
  /** Injected for deterministic tests. Production needs a continuous clock
   * plus wall time so sleep/clock adjustments cannot extend authority. */
  clock?: () => { wallMs: number; monotonicMs: number };
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const exactKeys = (v: unknown, names: readonly string[]) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const identityKeys = ['userId', 'serverId', 'deviceId', 'workspaceId'] as const;
const identityValid = (v: AutomationIdentity) => exactKeys(v, identityKeys) && identityKeys.every(k => uuid(v[k]));
const sameIdentity = (a: AutomationIdentity, b: AutomationIdentity) => identityKeys.every(k => a[k] === b[k]);
function validAuthority(a: DeviceAuthority): boolean {
  const refs = [a?.consent, a?.permissions, a?.cardinal];
  return exactKeys(a, ['consent', 'permissions', 'cardinal'])
    && refs.every(r => exactKeys(r, ['recordId', 'version', 'digest', 'epoch']) && uuid(r.recordId) && integer(r.version) && r.version > 0
      && integer(r.epoch) && r.epoch > 0 && typeof r.digest === 'string' && /^[a-f0-9]{64}$/.test(r.digest))
    && new Set(refs.map(r => r.recordId)).size === 3 && new Set(refs.map(r => r.epoch)).size === 1;
}
const sameAuthority = (a: DeviceAuthority, b: DeviceAuthority) => (['consent', 'permissions', 'cardinal'] as const).every(k =>
  a[k].recordId === b[k].recordId && a[k].version === b[k].version && a[k].digest === b[k].digest && a[k].epoch === b[k].epoch);
function validAction(a: AutomationAction): boolean {
  if (!a || typeof a !== 'object') return false;
  const exact = (names: string[]) => Object.keys(a).sort().join(',') === names.sort().join(',');
  switch (a.kind) {
    case 'browser.observe': return exact(['kind', 'browserProfileId', 'tabId']) && uuid(a.browserProfileId) && uuid(a.tabId);
    case 'browser.navigate': return exact(['kind', 'browserProfileId', 'tabId', 'url']) && uuid(a.browserProfileId) && uuid(a.tabId)
      && typeof a.url === 'string' && a.url.length <= 8192 && !/[\u0000-\u0020\u007f]/u.test(a.url)
      && (() => { try { const u = new URL(a.url); return ['https:', 'http:'].includes(u.protocol) && !u.username && !u.password; } catch { return false; } })();
    case 'browser.element': return exact(['kind', 'browserProfileId', 'tabId', 'elementId', 'action', ...(a.valueReference === undefined ? [] : ['valueReference'])])
      && uuid(a.browserProfileId) && uuid(a.tabId) && uuid(a.elementId) && ['click', 'fill'].includes(a.action)
      && (a.action === 'fill' ? uuid(a.valueReference) : a.valueReference === undefined);
    case 'desktop.observe': return exact(['kind', 'appId', 'windowId']) && uuid(a.appId) && uuid(a.windowId);
    case 'desktop.element': return exact(['kind', 'appId', 'windowId', 'elementId', 'action']) && uuid(a.appId) && uuid(a.windowId)
      && uuid(a.elementId) && ['press', 'focus'].includes(a.action);
    case 'desktop.pointer': return exact(['kind', 'appId', 'windowId', 'x', 'y', 'action']) && uuid(a.appId) && uuid(a.windowId)
      && Number.isFinite(a.x) && Number.isFinite(a.y) && a.x >= 0 && a.y >= 0 && a.action === 'click';
    default: return false;
  }
}
function validCommand(c: VerifiedDeviceCommand): boolean {
  return exactKeys(c, ['id', 'reservationId', 'identity', 'bootId', 'channelId', 'taskId', 'generation', 'sequence', 'authority', 'expiresAtMs', 'observation', 'action'])
    && uuid(c.id) && uuid(c.reservationId) && uuid(c.bootId) && uuid(c.channelId) && uuid(c.taskId)
    && identityValid(c.identity) && validAuthority(c.authority) && integer(c.generation) && integer(c.sequence) && c.sequence > 0
    && integer(c.expiresAtMs) && exactKeys(c.observation, ['id', 'targetId', 'targetRevision', 'generation']) && uuid(c.observation.id) && uuid(c.observation.targetId)
    && integer(c.observation.targetRevision) && c.observation.targetRevision > 0 && integer(c.observation.generation)
    && validAction(c.action) && c.observation.targetId === ('tabId' in c.action ? c.action.tabId : c.action.windowId);
}
const MAX_LEASE_MS = 60_000;

/** Local, volatile fail-closed control boundary. Production assembly/transport,
 * persistent enrollment and native adapters are intentionally not installed by
 * this module. No state survives restart: old boot IDs cannot dispatch. Keep
 * `local` in the protected host process; expose ONLY `bridge` to the transport. */
export function createDeviceControlGate(identity: AutomationIdentity, ports: DeviceControlPorts) {
  if (!identityValid(identity) || ['verifyLocalConsent', 'verifyChannel', 'verifyCommand', 'verifyReconciliation', 'currentObservation', 'invoke'].some(k => typeof ports?.[k as keyof DeviceControlPorts] !== 'function')) {
    throw new Error('A verified local device boundary and all adapters are required.');
  }
  const ownIdentity = structuredClone(identity), bootId = randomUUID();
  const clock = ports.clock ?? (() => ({ wallMs: Date.now(), monotonicMs: performance.now() }));
  let generation = 0, consent: DeviceConsent | null = null;
  let channel: { channelId: string; expiresAtMs: number; monotonicDeadline: number } | null = null;
  let holder: DeviceControlState['holder'] = 'none', taskId: string | null = null, suspended = true;
  let leaseWall = 0, leaseMonotonic = 0, consentMonotonic = 0;
  let lastClock: ReturnType<typeof clock> | null = null, timer: ReturnType<typeof setTimeout> | null = null;
  let flight: AbortController | null = null, verifying = false;
  let localRequest = 0, channelRequest = 0, lastSequence = 0;
  const commandIds = new Set<string>(), reservationIds = new Set<string>(), channelIds = new Set<string>();
  const uncertain = new Set<string>();
  const snapshot = (): DeviceControlState => ({ bootId, generation, consented: !!consent, connected: !!channel, holder, taskId, busy: !!flight || verifying, paused: suspended, uncertainActions: uncertain.size });
  function invalidate(next: DeviceControlState['holder'] = 'none') {
    generation += 1; holder = next; leaseWall = 0; leaseMonotonic = 0;
    if (next === 'none') taskId = null;
    flight?.abort(); flight = null;
  }
  function stop() {
    localRequest += 1; channelRequest += 1; consent = null; channel = null; suspended = true;
    invalidate(); if (timer) clearTimeout(timer); timer = null;
  }
  function now() {
    const current = clock();
    if (!integer(current.wallMs) || !Number.isFinite(current.monotonicMs) || current.monotonicMs < 0
      || lastClock && (current.wallMs < lastClock.wallMs || current.monotonicMs < lastClock.monotonicMs)) {
      stop(); throw new Error('Device clock requires revalidation.');
    }
    lastClock = current; return current;
  }
  function live() {
    const current = now();
    if (consent && (current.wallMs >= consent.expiresAtMs || current.monotonicMs >= consentMonotonic)) { stop(); return current; }
    if (channel && (current.wallMs >= channel.expiresAtMs || current.monotonicMs >= channel.monotonicDeadline)) { channel = null; channelRequest += 1; invalidate(holder === 'human' ? 'human' : 'none'); }
    if (holder === 'agent' && (current.wallMs >= leaseWall || current.monotonicMs >= leaseMonotonic)) invalidate();
    return current;
  }
  function arm() {
    if (timer) clearTimeout(timer); timer = null;
    const current = live();
    const delays = [consent ? consent.expiresAtMs - current.wallMs : Infinity, consent ? consentMonotonic - current.monotonicMs : Infinity,
      channel ? channel.expiresAtMs - current.wallMs : Infinity, channel ? channel.monotonicDeadline - current.monotonicMs : Infinity,
      holder === 'agent' ? leaseWall - current.wallMs : Infinity, holder === 'agent' ? leaseMonotonic - current.monotonicMs : Infinity];
    const delay = Math.min(...delays);
    if (Number.isFinite(delay)) { timer = setTimeout(() => { try { live(); arm(); } catch { stop(); } }, Math.max(1, Math.min(delay, MAX_LEASE_MS))); timer.unref(); }
  }
  const denied = (code: string, command?: VerifiedDeviceCommand): DeviceDispatchReceipt => ({ commandId: command?.id ?? null,
    reservationId: command?.reservationId ?? null, outcome: 'denied', code, evidenceIds: [] });
  function unresolved(code: string, command: VerifiedDeviceCommand): DeviceDispatchReceipt {
    uncertain.add(command.reservationId); invalidate(holder === 'human' ? 'human' : 'none');
    return { ...denied(code, command), outcome: 'uncertain' };
  }
  function observationMatches(command: VerifiedDeviceCommand): boolean {
    const actual = ports.currentObservation(), expected = command.observation;
    return !!actual && actual.id === expected.id && actual.targetId === expected.targetId && actual.targetRevision === expected.targetRevision
      && actual.generation === generation && expected.generation === generation;
  }
  function ready(command: VerifiedDeviceCommand, expectedGeneration: number, checkObservation = true): boolean {
    const current = live();
    return expectedGeneration === generation && !!consent && !!channel && !suspended && holder === 'agent' && command.bootId === bootId
      && sameIdentity(command.identity, ownIdentity) && sameAuthority(command.authority, consent.authority)
      && command.channelId === channel.channelId && command.generation === generation && command.taskId === taskId
      && command.expiresAtMs > current.wallMs && command.expiresAtMs <= leaseWall && (!checkObservation || observationMatches(command));
  }
  async function execute(packet: unknown): Promise<DeviceDispatchReceipt> {
    let command: VerifiedDeviceCommand | null = null, dispatched = false, controller: AbortController | null = null;
    let commandTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      live();
      if (!consent || !channel || suspended || uncertain.size || holder !== 'agent') return denied('control_unavailable');
      if (flight || verifying) return denied('busy');
      if (commandIds.size >= 4096) { stop(); return denied('replay_capacity'); }
      const capturedGeneration = generation;
      verifying = true;
      controller = new AbortController(); flight = controller;
      const aborted = new Promise<never>((_resolve, reject) => controller!.signal.addEventListener('abort', () => reject(new Error('interrupted')), { once: true }));
      const verified = await Promise.race([ports.verifyCommand(structuredClone(packet), Object.freeze(snapshot()), controller.signal), aborted]);
      command = verified ? structuredClone(verified) : null;
      if (!command || !validCommand(command)) return denied('invalid_command');
      if (!ready(command, capturedGeneration)) return denied('stale_control', command);
      if (command.sequence !== lastSequence + 1 || commandIds.has(command.id) || reservationIds.has(command.reservationId)) return denied('replay', command);
      // Consume before invoking: a throw/timeout after this point may still have
      // produced an external effect. Reconnection never clears this boot's IDs.
      lastSequence = command.sequence; commandIds.add(command.id); reservationIds.add(command.reservationId);
      commandTimer = setTimeout(() => controller!.abort(), Math.max(1, command.expiresAtMs - now().wallMs)); commandTimer.unref();
      dispatched = true;
      const result = await Promise.race([ports.invoke(structuredClone(command), controller.signal), aborted]);
      if (controller.signal.aborted || !ready(command, capturedGeneration, false)) return unresolved('control_changed', command);
      if (!result || !['succeeded', 'failed', 'uncertain'].includes(result.outcome) || !Array.isArray(result.evidenceIds)
        || result.evidenceIds.length > 64 || result.evidenceIds.some(e => !uuid(e)) || result.outcome !== 'uncertain' && !result.evidenceIds.length) {
        return unresolved('result_unverified', command);
      }
      if (result.outcome === 'uncertain') return { ...unresolved('reported', command), evidenceIds: [...result.evidenceIds] };
      return { commandId: command.id, reservationId: command.reservationId, outcome: result.outcome, code: 'reported', evidenceIds: [...result.evidenceIds] };
    } catch {
      return dispatched && command ? unresolved('interrupted_or_unverified', command) : denied('verification_unavailable', command ?? undefined);
    } finally {
      if (commandTimer) clearTimeout(commandTimer);
      verifying = false;
      if (flight === controller) flight = null;
    }
  }
  const local = Object.freeze({
    async consent(proof: unknown): Promise<boolean> {
      // Revocation happens before the dialog/verification. A late answer after
      // Stop cannot silently restore consent.
      stop(); lastClock = null; const request = localRequest;
      try {
        const verified = await ports.verifyLocalConsent(proof), candidate = verified ? structuredClone(verified) : null, current = now();
        if (request !== localRequest || !candidate || !exactKeys(candidate, ['identity', 'authority', 'expiresAtMs']) || !identityValid(candidate.identity) || !sameIdentity(candidate.identity, ownIdentity)
          || !validAuthority(candidate.authority) || !integer(candidate.expiresAtMs) || candidate.expiresAtMs <= current.wallMs) return false;
        consent = candidate; suspended = false; consentMonotonic = current.monotonicMs + candidate.expiresAtMs - current.wallMs; arm(); return true;
      } catch { return false; }
    },
    stop,
    pause() { live(); suspended = true; invalidate(); arm(); },
    takeOver() { live(); suspended = true; invalidate('human'); arm(); },
    resume() { live(); if (!consent || !channel || uncertain.size) return false; suspended = false; invalidate(); arm(); return true; },
    /** Vault/policy loss invalidates even standing local authority. A server
     * cannot install a new policy generation without local reconciliation. */
    authorityLost: stop,
  });
  const bridge = Object.freeze({
    async connect(proof: unknown): Promise<boolean> {
      try {
        live(); if (!consent) return false;
        channel = null; invalidate(holder === 'human' ? 'human' : 'none'); const expectedGeneration = generation, request = ++channelRequest, boundConsent = structuredClone(consent);
        const verified = await ports.verifyChannel(proof, boundConsent, bootId), candidate = verified ? structuredClone(verified) : null, current = live();
        if (request !== channelRequest || expectedGeneration !== generation || !consent || !candidate || !exactKeys(candidate, ['channelId', 'authority', 'expiresAtMs']) || !uuid(candidate.channelId)
          || channelIds.has(candidate.channelId) || channelIds.size >= 4096 || !validAuthority(candidate.authority)
          || !sameAuthority(candidate.authority, consent.authority) || !integer(candidate.expiresAtMs)
          || candidate.expiresAtMs <= current.wallMs || candidate.expiresAtMs > consent.expiresAtMs
          || candidate.expiresAtMs - current.wallMs > MAX_LEASE_MS) return false;
        channelIds.add(candidate.channelId); lastSequence = 0;
        channel = { channelId: candidate.channelId, expiresAtMs: candidate.expiresAtMs, monotonicDeadline: current.monotonicMs + candidate.expiresAtMs - current.wallMs };
        arm(); return true;
      } catch { return false; }
    },
    disconnect() { channelRequest += 1; channel = null; invalidate(holder === 'human' ? 'human' : 'none'); arm(); },
    /** An authenticated channel may request work only inside local consent.
     * The server cannot displace a human or another task/controller. */
    acquireTask(id: string, expiresAtMs: number): number | null {
      try {
        const current = live();
        if (!consent || !channel || suspended || uncertain.size || holder !== 'none' || flight || verifying || !uuid(id) || !integer(expiresAtMs)
          || expiresAtMs <= current.wallMs || expiresAtMs > channel.expiresAtMs || expiresAtMs - current.wallMs > MAX_LEASE_MS) return null;
        generation += 1; holder = 'agent'; taskId = id; leaseWall = expiresAtMs;
        leaseMonotonic = current.monotonicMs + expiresAtMs - current.wallMs; arm(); return generation;
      } catch { return null; }
    },
    releaseTask(id: string, expectedGeneration: number): boolean {
      try {
        live();
        if (holder !== 'agent' || taskId !== id || generation !== expectedGeneration || flight || verifying) return false;
        invalidate(); arm(); return true;
      } catch { return false; }
    },
    async reconcile(proof: unknown): Promise<boolean> {
      try {
        live(); if (!consent || !channel || flight || verifying || !uncertain.size) return false;
        const expectedGeneration = generation, ids = [...uncertain];
        const accepted = await ports.verifyReconciliation(proof, { identity: structuredClone(ownIdentity), bootId, channelId: channel.channelId,
          authority: structuredClone(consent.authority), reservationIds: [...ids] });
        live();
        if (accepted !== true || expectedGeneration !== generation || !consent || !channel
          || uncertain.size !== ids.length || ids.some(id => !uncertain.has(id))) return false;
        uncertain.clear(); return true;
      } catch { return false; }
    },
    execute,
  });
  return Object.freeze({ local, bridge, state: () => { try { live(); } catch { /* stop already applied */ } return snapshot(); } });
}
