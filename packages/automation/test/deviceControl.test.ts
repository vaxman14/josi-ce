import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeviceControlGate, type DeviceConsent, type DeviceControlPorts, type VerifiedDeviceCommand } from '../src/deviceControl.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const identity = { userId: id(1), serverId: id(2), deviceId: id(3), workspaceId: id(4) };
const ref = (n: number) => ({ recordId: id(n), version: 1, digest: 'a'.repeat(64), epoch: 5 });
const authority = { consent: ref(10), permissions: ref(11), cardinal: ref(12) };
const stopped: Array<() => void> = [];
afterEach(() => { for (const stop of stopped.splice(0)) stop(); vi.useRealTimers(); });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function fixture(patch: Partial<DeviceControlPorts> = {}) {
  let wall = 10_000, mono = 100, channelId = id(20);
  let observation = { id: id(30), targetId: id(31), targetRevision: 1, generation: 0 };
  const consent = (): DeviceConsent => ({ identity: { ...identity }, authority: structuredClone(authority), expiresAtMs: wall + 120_000 });
  const invoke = vi.fn<DeviceControlPorts['invoke']>(async () => ({ outcome: 'succeeded', evidenceIds: [id(32)] }));
  const verifyCommand = vi.fn<DeviceControlPorts['verifyCommand']>(async packet => packet as VerifiedDeviceCommand);
  // Deliberately synthetic verification. None of these fixtures authenticates
  // a real human, Vault, network peer, budget reservation or native operation.
  const ports: DeviceControlPorts = {
    verifyLocalConsent: async proof => proof === 'local-fixture' ? consent() : null,
    verifyChannel: async proof => proof === 'channel-fixture' ? { channelId, authority: structuredClone(authority), expiresAtMs: wall + 60_000 } : null,
    verifyCommand, verifyReconciliation: async proof => proof === 'reconciled-fixture', currentObservation: () => observation, invoke, clock: () => ({ wallMs: wall, monotonicMs: mono }), ...patch,
  };
  const gate = createDeviceControlGate(identity, ports); stopped.push(gate.local.stop);
  const observe = () => { observation = { ...observation, id: id(30), generation: gate.state().generation }; };
  const command = (n = 1): VerifiedDeviceCommand => ({ id: id(100 + n), reservationId: id(200 + n), identity: { ...identity },
    bootId: gate.state().bootId, channelId, taskId: id(40), generation: gate.state().generation, sequence: n,
    authority: structuredClone(authority), expiresAtMs: wall + 1000, observation: { ...observation },
    action: { kind: 'browser.observe', browserProfileId: id(41), tabId: id(31) } });
  async function ready() {
    expect(await gate.local.consent('local-fixture')).toBe(true);
    expect(await gate.bridge.connect('channel-fixture')).toBe(true);
    expect(gate.bridge.acquireTask(id(40), wall + 30_000)).not.toBeNull(); observe();
  }
  return { gate, ports, ready, command, invoke, verifyCommand, observe, consent,
    changeObservation: (patch: Partial<typeof observation>) => { observation = { ...observation, ...patch }; },
    clock: (wallDelta: number, monoDelta = wallDelta) => { wall += wallDelta; mono += monoDelta; },
    newChannel: () => { channelId = id(Number(channelId.slice(-12)) + 1); },
  };
}
describe('local device control boundary with synthetic authority ports', () => {
  it('remote bridge cannot enroll/enable a device; all authority ports must exist', async () => {
    const f = fixture();
    expect(Object.keys(f.gate.bridge).sort()).toEqual(['acquireTask', 'connect', 'disconnect', 'execute', 'reconcile', 'releaseTask']);
    expect(await f.gate.bridge.connect('channel-fixture')).toBe(false);
    expect(f.gate.bridge.acquireTask(id(40), 20_000)).toBeNull();
    expect((await f.gate.bridge.execute(f.command())).outcome).toBe('denied');
    expect(await f.gate.local.consent('remote-says-human-approved')).toBe(false);
    expect(f.invoke).not.toHaveBeenCalled();
    expect(() => createDeviceControlGate(identity, {} as never)).toThrow(/all adapters/);
  });
  it('inside verified local consent, a task can act, report evidence and release control', async () => {
    const f = fixture(); await f.ready(); const command = f.command();
    expect(await f.gate.bridge.execute(command)).toEqual({ commandId: command.id, reservationId: command.reservationId, outcome: 'succeeded', code: 'reported', evidenceIds: [id(32)] });
    expect(f.invoke).toHaveBeenCalledTimes(1);
    expect(f.gate.bridge.releaseTask(id(99), command.generation)).toBe(false);
    expect(f.gate.bridge.releaseTask(command.taskId, command.generation)).toBe(true);
    expect(f.gate.state()).toMatchObject({ holder: 'none', taskId: null });
  });
  it.each(['userId', 'serverId', 'deviceId', 'workspaceId'] as const)('rejects wrong %s even after upstream verification', async field => {
    const f = fixture(); await f.ready(); const command = f.command(); command.identity[field] = id(99);
    expect((await f.gate.bridge.execute(command)).outcome).toBe('denied'); expect(f.invoke).not.toHaveBeenCalled();
  });
  it.each(['bootId', 'channelId', 'taskId'] as const)('rejects a mismatched %s', async field => {
    const f = fixture(); await f.ready(); const command = f.command(); command[field] = id(99);
    expect((await f.gate.bridge.execute(command)).outcome).toBe('denied'); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('rejects changed authority and a remote handshake cannot widen local consent', async () => {
    const f = fixture(); await f.ready(); const command = f.command(); command.authority.permissions.version += 1;
    expect((await f.gate.bridge.execute(command)).outcome).toBe('denied');
    f.newChannel(); f.ports.verifyChannel = async () => ({ channelId: id(99), authority: command.authority, expiresAtMs: 20_000 });
    expect(await f.gate.bridge.connect('anything')).toBe(false);
    expect(f.gate.state().connected).toBe(false); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('old or changed observations and cross-target actions never dispatch', async () => {
    const f = fixture(); await f.ready(); const command = f.command();
    f.changeObservation({ targetRevision: 2 }); expect((await f.gate.bridge.execute(command)).outcome).toBe('denied');
    f.changeObservation({ targetRevision: 1, targetId: id(99) }); expect((await f.gate.bridge.execute(command)).outcome).toBe('denied');
    f.changeObservation({ targetId: id(31) }); command.observation.generation -= 1;
    expect((await f.gate.bridge.execute(command)).outcome).toBe('denied');
    command.observation.generation += 1; command.action = { kind: 'browser.observe', browserProfileId: id(41), tabId: id(99) };
    expect((await f.gate.bridge.execute(command)).outcome).toBe('denied'); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('rechecks focus after delayed upstream verification', async () => {
    const wait = deferred<VerifiedDeviceCommand | null>(); const f = fixture({ verifyCommand: async () => wait.promise }); await f.ready();
    const command = f.command(), result = f.gate.bridge.execute(command);
    f.changeObservation({ targetRevision: 2 }); wait.resolve(command);
    expect((await result).outcome).toBe('denied'); expect(f.invoke).not.toHaveBeenCalled();
  });
  it('takeover cancels pending verification, and a late result cannot act', async () => {
    const wait = deferred<VerifiedDeviceCommand | null>(); const f = fixture({ verifyCommand: async () => wait.promise }); await f.ready();
    const command = f.command(), result = f.gate.bridge.execute(command); f.gate.local.takeOver();
    expect((await result).outcome).toBe('denied'); wait.resolve(command); await Promise.resolve();
    expect(f.invoke).not.toHaveBeenCalled(); expect(f.gate.state()).toMatchObject({ holder: 'human', paused: true, busy: false });
  });
  it.each(['pause', 'takeOver'] as const)('remote reconnect/acquire cannot undo local %s', async control => {
    const f = fixture(); await f.ready(); const old = f.command(); f.gate.local[control]();
    expect(f.gate.bridge.acquireTask(id(40), 20_000)).toBeNull();
    f.newChannel(); expect(await f.gate.bridge.connect('channel-fixture')).toBe(true);
    expect(f.gate.bridge.acquireTask(id(40), 20_000)).toBeNull();
    expect(f.gate.state().paused).toBe(true);
    expect(f.gate.local.resume()).toBe(true);
    expect(f.gate.bridge.acquireTask(id(40), 20_000)).not.toBeNull();
    expect((await f.gate.bridge.execute(old)).outcome).toBe('denied');
    expect((await f.gate.bridge.execute(f.command())).outcome).toBe('denied'); // must re-observe
    f.observe(); expect((await f.gate.bridge.execute(f.command())).outcome).toBe('succeeded');
  });
  it('a stopped device requires new local consent, including after reconnect', async () => {
    const f = fixture(); await f.ready(); f.gate.local.stop(); f.newChannel();
    expect(await f.gate.bridge.connect('channel-fixture')).toBe(false);
    expect(f.gate.local.resume()).toBe(false); expect(f.gate.state()).toMatchObject({ consented: false, connected: false, holder: 'none' });
  });
  it('a consent dialog answered after Stop cannot revive the device', async () => {
    const wait = deferred<DeviceConsent | null>(), f = fixture({ verifyLocalConsent: async () => wait.promise });
    const result = f.gate.local.consent('fixture'); f.gate.local.stop(); wait.resolve(f.consent());
    expect(await result).toBe(false); expect(f.gate.state().consented).toBe(false);
  });
  it('a late handshake after authority loss cannot reconnect', async () => {
    const wait = deferred<{ channelId: string; authority: typeof authority; expiresAtMs: number } | null>();
    const f = fixture({ verifyChannel: async () => wait.promise }); expect(await f.gate.local.consent('local-fixture')).toBe(true);
    const result = f.gate.bridge.connect('fixture'); f.gate.local.authorityLost();
    wait.resolve({ channelId: id(20), authority, expiresAtMs: 20_000 });
    expect(await result).toBe(false); expect(f.gate.state().consented).toBe(false);
  });
  it('does not queue commands or allow two tasks/controllers', async () => {
    const wait = deferred<{ outcome: 'succeeded'; evidenceIds: string[] }>(); const f = fixture({ invoke: async () => wait.promise }); await f.ready();
    expect(f.gate.bridge.acquireTask(id(99), 20_000)).toBeNull();
    const first = f.gate.bridge.execute(f.command()); await Promise.resolve();
    expect((await f.gate.bridge.execute(f.command(2))).code).toBe('busy');
    expect(f.gate.bridge.releaseTask(id(40), f.gate.state().generation)).toBe(false);
    wait.resolve({ outcome: 'succeeded', evidenceIds: [id(32)] }); expect((await first).outcome).toBe('succeeded');
  });
  it('replay, reused reservations and skipped sequence numbers never execute twice', async () => {
    const f = fixture(); await f.ready(); const first = f.command();
    expect((await f.gate.bridge.execute(first)).outcome).toBe('succeeded');
    expect((await f.gate.bridge.execute(first)).code).toBe('replay');
    expect((await f.gate.bridge.execute(f.command(3))).code).toBe('replay');
    expect((await f.gate.bridge.execute({ ...f.command(2), reservationId: first.reservationId })).code).toBe('replay');
    expect((await f.gate.bridge.execute({ ...f.command(2), id: first.id })).code).toBe('replay');
    expect((await f.gate.bridge.execute(f.command(2))).outcome).toBe('succeeded'); expect(f.invoke).toHaveBeenCalledTimes(2);
  });
  it('disconnect aborts in-flight work as uncertain; late success and a new channel do not replay it', async () => {
    const invoked = deferred<AbortSignal>(), completion = deferred<{ outcome: 'succeeded'; evidenceIds: string[] }>();
    const f = fixture({ invoke: async (_command, signal) => { invoked.resolve(signal); return completion.promise; } }); await f.ready();
    const command = f.command(), result = f.gate.bridge.execute(command); const signal = await invoked.promise;
    f.gate.bridge.disconnect(); expect(signal.aborted).toBe(true); expect((await result).outcome).toBe('uncertain');
    completion.resolve({ outcome: 'succeeded', evidenceIds: [id(32)] });
    f.newChannel(); expect(await f.gate.bridge.connect('channel-fixture')).toBe(true);
    expect(f.gate.bridge.acquireTask(id(40), 20_000)).toBeNull();
    expect(await f.gate.bridge.reconcile('model-says-done')).toBe(false);
    expect(await f.gate.bridge.reconcile('reconciled-fixture')).toBe(true);
    expect(f.gate.bridge.acquireTask(id(40), 20_000)).not.toBeNull(); f.observe();
    expect((await f.gate.bridge.execute(f.command())).code).toBe('replay');
    expect(f.gate.state().uncertainActions).toBe(0);
    expect(await f.gate.bridge.connect('channel-fixture')).toBe(false); // channel IDs are also one-use
  });
  it('native exceptions after dispatch are uncertain, never safe automatic retries or leaked exception text', async () => {
    const f = fixture({ invoke: async () => { throw new Error('private native details'); } }); await f.ready();
    const result = await f.gate.bridge.execute(f.command()); expect(result.outcome).toBe('uncertain'); expect(JSON.stringify(result)).not.toContain('private');
    expect((await f.gate.bridge.execute(f.command())).outcome).toBe('denied');
    expect(f.gate.state().uncertainActions).toBe(1);
    expect(f.gate.local.resume()).toBe(false);
  });
  it('successful changes may advance the observation revision, but need evidence', async () => {
    const f = fixture(); await f.ready(); f.ports.invoke = async () => { f.changeObservation({ targetRevision: 2 }); return { outcome: 'succeeded', evidenceIds: [id(32)] }; };
    expect((await f.gate.bridge.execute(f.command())).outcome).toBe('succeeded');
    f.ports.invoke = async () => ({ outcome: 'succeeded', evidenceIds: [] });
    expect((await f.gate.bridge.execute(f.command(2))).outcome).toBe('uncertain');
  });
  it('command expiry aborts an adapter even before the longer control lease expires', async () => {
    vi.useFakeTimers(); const invoked = deferred<AbortSignal>();
    const f = fixture({ invoke: async (_c, signal) => { invoked.resolve(signal); return new Promise(() => {}); } }); await f.ready();
    const command = f.command(); command.expiresAtMs = 10_010;
    const result = f.gate.bridge.execute(command), signal = await invoked.promise;
    f.clock(10); await vi.advanceTimersByTimeAsync(10);
    expect(signal.aborted).toBe(true); expect((await result).outcome).toBe('uncertain');
  });
  it('expiry cancels hung verification and does not require another packet to stop', async () => {
    vi.useFakeTimers(); const f = fixture({ verifyCommand: async () => new Promise(() => {}) }); await f.ready();
    const result = f.gate.bridge.execute(f.command()); f.clock(30_000); await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).outcome).toBe('denied'); expect(f.invoke).not.toHaveBeenCalled(); expect(f.gate.state().holder).toBe('none');
  });
  it('wall or monotonic clock rollback revokes authority; only fresh local consent resets it', async () => {
    for (const deltas of [[-1, 1], [1, -1]]) {
      const f = fixture(); await f.ready(); f.clock(deltas[0], deltas[1]);
      expect(f.gate.state().consented).toBe(false); expect((await f.gate.bridge.execute(f.command())).outcome).toBe('denied');
      expect(await f.gate.local.consent('local-fixture')).toBe(true);
    }
  });
  it('rejects expired/overlong leases, unknown actions, raw fill text and target mismatches', async () => {
    const f = fixture(); await f.ready();
    for (const action of [{ kind: 'shell', command: 'anything' }, { kind: 'browser.element', browserProfileId: id(41), tabId: id(31), elementId: id(42), action: 'fill', valueReference: 'raw secret' },
      { kind: 'browser.observe', browserProfileId: id(41), tabId: id(31), extraOperation: 'delete' }]) {
      expect((await f.gate.bridge.execute({ ...f.command(), action } as never)).outcome).toBe('denied');
    }
    for (const expiresAtMs of [10_000, 41_000, Infinity]) expect((await f.gate.bridge.execute({ ...f.command(), expiresAtMs })).outcome).toBe('denied');
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it('a new process gets a different boot identity and cannot accept the previous process command', async () => {
    const first = fixture(), second = fixture(); await first.ready(); await second.ready();
    expect(first.gate.state().bootId).not.toBe(second.gate.state().bootId);
    expect((await second.gate.bridge.execute(first.command())).outcome).toBe('denied'); expect(second.invoke).not.toHaveBeenCalled();
  });
  it('reconciliation is exact, cannot undo a human pause, and late proof after authority loss is refused', async () => {
    const f = fixture({ invoke: async () => ({ outcome: 'uncertain', evidenceIds: [] }) }); await f.ready();
    const command = f.command(); expect((await f.gate.bridge.execute(command)).outcome).toBe('uncertain');
    expect(f.gate.state().uncertainActions).toBe(1); f.gate.local.pause();
    f.ports.verifyReconciliation = async (_proof, context) => { expect(context.reservationIds).toEqual([command.reservationId]); expect(context.authority).toEqual(authority); return true; };
    expect(await f.gate.bridge.reconcile('fixture')).toBe(true);
    expect(f.gate.bridge.acquireTask(id(40), 20_000)).toBeNull(); expect(f.gate.state().paused).toBe(true);
    expect(f.gate.local.resume()).toBe(true); expect(f.gate.bridge.acquireTask(id(40), 20_000)).not.toBeNull(); f.observe();
    expect((await f.gate.bridge.execute(f.command(2))).outcome).toBe('uncertain');
    const wait = deferred<boolean>(); f.ports.verifyReconciliation = async () => wait.promise;
    const answer = f.gate.bridge.reconcile('fixture'); f.gate.local.authorityLost(); wait.resolve(true);
    expect(await answer).toBe(false); expect(f.gate.state().uncertainActions).toBe(1);
  });
});
