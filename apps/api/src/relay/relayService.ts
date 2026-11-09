// The server's side of Hey Josi: its keys, its paired devices, the link to the
// relay and the LAN listener, and the sync with a hosted account.
//
// What a hosted account can do here is deliberately small. It can pass this
// server a plan, a grant and a device revocation. It can't add a device, and
// nothing it says opens a session: a device only ever reaches the same sign-in a
// person would reach on the server's own address.
import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { appendEvent, json, loadMasterKey, openSealed, seal, type Db, type LoadOptions } from '@josi-ce/core';
import { NOISE_KEYS, createStateStore, fetchIdentity, hostedCall, serverKeyStore, upsertConnection, HEY_JOSI_CLIENT, type ResolvedHandshake, type StoredNoiseKeys } from '@josi-ce/connectors';
import {
  PAIRING_TTL_SECONDS, TunnelHost, codeHash, displayCode, equal, fromB64url, generateKeyPair, inviteId, newPairingCode, pairingLink,
  rpcCall, sealInvite, staticKeyFrom, toB64url, type Authorized, type HostedDevice, type HostedHello, type Hello, type InviteBox, type LinkReply,
  type StaticKey, type SyncReply, type Welcome,
} from '@josi-ce/tunnel';
import { DEFAULT_LAN_PORT, LAN_PATH, RelayLink, httpBridge, lanListener, type KeyStore } from '@josi-ce/tunnel/node';

export const RELAY_SECRET = 'relay-secret';
export const AI_TOKEN = 'hey-josi-ai';
export const HOSTED_URL = 'https://accounts.heyjosi.com';
/** The service's key, built in so a link never has to trust what the network says it is. */
export const HOSTED_PUBLIC_KEY = '7zFMIQd5BBMjZwx5SZCwUSh0xCbarEVFcUGOqTzlhgg';
const ROTATION_OVERLAP_DAYS = 30;
const DEVICE_OVERLAP_MINUTES = 10;
const SYNC_MS = 6 * 3600_000;
const SEEN_WRITE_MS = 60_000;
const HANDOFF_TTL_MS = 2 * 60_000;

export class RelayError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export interface LinkRow {
  hosted_url: string | null; hosted_public: string | null; server_id: string | null; site: string | null; name: string | null; relay_url: string | null;
  plan: 'free' | 'connect' | 'connect_ai'; ai_base_url: string | null; usage: unknown; relay_enabled: boolean; lan_enabled: boolean;
  linked_at: string; last_sync_at: string | null; last_sync_error: string | null;
}
export interface DeviceRow {
  id: string; owner_user_id: string; name: string; platform: string; public_key: string; previous_public_key: string | null; previous_until: string | null;
  paired_at: string; last_seen_at: string | null; revoked_at: string | null;
}
export interface RelayServiceOptions {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Where the local API answers, for tunnelled requests. */
  apiPort: number;
  hostedUrl?: string;
  /** Pins the hosted key. Unset, HOSTED_URL uses the built-in key and any other
   * address has its key fetched over HTTPS when linking. */
  hostedPublicKey?: string;
  /** 0 takes any free port. Null turns the direct path off. */
  lanPort?: number | null;
  fetchImpl?: typeof fetch;
  connectorFetch?: typeof fetch;
  keyStore?: KeyStore;
}

const clean = (value: unknown, max: number, fallback: string): string => {
  // eslint-disable-next-line no-control-regex
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : '';
  return text || fallback;
};

function lanHosts(): string[] {
  // In a container the interfaces are the container's own, which no device can
  // reach, so the address has to be given.
  if (process.env.JOSI_LAN_HOST) return [process.env.JOSI_LAN_HOST];
  if (existsSync('/.dockerenv')) return [];
  const out: string[] = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (/virtual|vmware|hyper-v|vethernet|docker|wsl|tailscale|zerotier|loopback|utun|bridge/i.test(name)) continue;
    for (const entry of entries ?? []) if (!entry.internal && entry.family === 'IPv4') out.push(entry.address);
  }
  return out;
}

export class RelayService {
  private readonly db: Db;
  private store: KeyStore | null = null;
  private keysCache: { current: StaticKey; previous: StaticKey | null; previousUntil: number } | null = null;
  private readonly host: TunnelHost;
  private readonly bridge: ReturnType<typeof httpBridge>;
  private link: RelayLink | null = null;
  private lan: Awaited<ReturnType<typeof lanListener>> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private address = '';
  private readonly seen = new Map<string, number>();
  private syncing: Promise<void> = Promise.resolve();
  private readonly handoffs = new Map<string, { handshake: ResolvedHandshake; expires: number }>();

  constructor(private readonly opts: RelayServiceOptions) {
    this.db = opts.db;
    this.bridge = httpBridge({ port: opts.apiPort, publicHost: () => this.address || 'localhost' });
    this.host = new TunnelHost({
      keys: () => this.liveKeys(),
      authorize: (hello, remote, index) => this.authorize(hello, remote, index),
      special: (hello, remote) => this.hostedHello(hello as unknown as HostedHello, remote),
      onRequest: call => this.bridge.handle(call),
      onRotateDevice: (device, oldKey, newKey) => this.rotateDeviceKey(device, oldKey, newKey),
      onSeen: device => this.noteSeen(device),
    });
  }

  get tunnelHost(): TunnelHost { return this.host; }

  // ------------------------------------------------------------------ keys

  private async keyStore(): Promise<KeyStore> {
    this.store ??= this.opts.keyStore ?? await serverKeyStore();
    return this.store;
  }

  private async keys(): Promise<NonNullable<RelayService['keysCache']>> {
    if (this.keysCache) return this.keysCache;
    const store = await this.keyStore();
    let raw = await store.get(NOISE_KEYS);
    if (!raw) {
      raw = JSON.stringify({ current: toB64url(generateKeyPair().privateKey) } satisfies StoredNoiseKeys);
      await store.set(NOISE_KEYS, raw);
    }
    const stored = JSON.parse(raw) as StoredNoiseKeys;
    const previousUntil = stored.previousUntil ? Date.parse(stored.previousUntil) : 0;
    this.keysCache = {
      current: staticKeyFrom(fromB64url(stored.current)),
      previous: stored.previous && previousUntil > Date.now() ? staticKeyFrom(fromB64url(stored.previous)) : null,
      previousUntil,
    };
    return this.keysCache;
  }

  private liveKeys(): StaticKey[] {
    const keys = this.keysCache;
    if (!keys) return [];
    return keys.previous && keys.previousUntil > Date.now() ? [keys.current, keys.previous] : [keys.current];
  }

  async publicKey(): Promise<string> { return toB64url((await this.keys()).current.publicKey); }

  /** Normal rotation keeps the old key working for a month, so a device that's
   * been away picks up the new one. `immediate` is for a key you think was stolen:
   * the old one is destroyed now, and anything offline has to pair again. */
  async rotateServerKey(args: { immediate: boolean; actorUserId: string }): Promise<{ publicKey: string; previousUntil: string | null }> {
    await this.keys();
    const row = await this.row();
    const next = generateKeyPair();
    const publicKey = toB64url(next.publicKey);
    if (row?.hosted_url) {
      const reply = await hostedCall(this.db, { op: 'rotate-key', publicKey }, { fetchImpl: this.opts.fetchImpl });
      if (!reply.ok) throw new RelayError(502, 'heyjosi.com did not accept the new key, so nothing changed.');
    }
    const store = await this.keyStore();
    const raw = JSON.parse((await store.get(NOISE_KEYS))!) as StoredNoiseKeys;
    const until = args.immediate ? null : new Date(Date.now() + ROTATION_OVERLAP_DAYS * 86_400_000).toISOString();
    await store.set(NOISE_KEYS, JSON.stringify({ current: toB64url(next.privateKey), previous: args.immediate ? null : raw.current, previousUntil: until } satisfies StoredNoiseKeys));
    this.keysCache = null;
    await this.keys();
    this.host.announceRotation(next.publicKey, until);
    if (args.immediate) this.host.disconnectAll();
    // A new key means a new refresh key too. The next sync registers it.
    await this.db.query('update hey_josi_link set refresh_key_enc = null');
    await this.sync().catch(() => undefined);
    await appendEvent(this.db, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'relay.server_key_rotated', payload: { immediate: args.immediate } });
    return { publicKey, previousUntil: until };
  }

  private async rotateDeviceKey(device: string, oldKey: Uint8Array, newKey: Uint8Array): Promise<void> {
    const rows = await this.db.query(
      `update relay_devices set previous_public_key = public_key, previous_until = now() + make_interval(mins => $4), public_key = $3
       where id = $1 and public_key = $2 and revoked_at is null returning id`,
      [device, toB64url(oldKey), toB64url(newKey), DEVICE_OVERLAP_MINUTES]);
    if (rows.length !== 1) throw new RelayError(409, 'This device key changed already.');
    await appendEvent(this.db, { actor: 'system', kind: 'relay.device_key_rotated', subjectType: 'relay_device', subjectId: device });
  }

  // --------------------------------------------------------------- devices

  private async authorize(hello: Hello, remote: Uint8Array, keyIndex: number): Promise<Authorized | Extract<Welcome, { ok: false }>> {
    const publicKey = toB64url(remote);
    const device = hello.op === 'pair' ? await this.consumeCode(hello, publicKey) : await this.findDevice(publicKey);
    if ('ok' in device) return device;
    const row = await this.row();
    const keys = await this.keys();
    return {
      device: device.id,
      client: hello.op === 'connect' ? clean(hello.client, 24, 'unknown') : clean(hello.platform, 24, 'unknown'),
      welcome: {
        ok: true, device: device.id, server: row?.name ?? 'josi', lan: this.lanAddresses(row),
        ...(keyIndex > 0 ? { rotate: { publicKey: toB64url(keys.current.publicKey), until: new Date(keys.previousUntil).toISOString() } } : {}),
      },
    };
  }

  private async findDevice(publicKey: string): Promise<DeviceRow | Extract<Welcome, { ok: false }>> {
    const [row] = await this.db.query<DeviceRow>(
      `select * from relay_devices where public_key = $1 or (previous_public_key = $1 and previous_until > now())`, [publicKey]);
    if (!row) return { ok: false, error: 'unknown_device' };
    return row.revoked_at ? { ok: false, error: 'revoked' } : row;
  }

  /** The code is spent first, in one statement, so two devices racing on the same
   * code can't both win. A failed pairing after that costs a new code, not safety. */
  private async consumeCode(hello: Extract<Hello, { op: 'pair' }>, publicKey: string): Promise<DeviceRow | Extract<Welcome, { ok: false }>> {
    if (typeof hello.code !== 'string') return { ok: false, error: 'bad_code' };
    const hash = codeHash(hello.code);
    const work = async (tx: Db) => {
      const [code] = await tx.query<{ owner_user_id: string }>(
        `update relay_pairing_codes set used_at = now() where code_hash = $1 and used_at is null and expires_at > now() returning owner_user_id`, [hash]);
      if (!code) return null;
      // A revoked key stays revoked. A device that wants back makes a new key.
      const [taken] = await tx.query(`select 1 from relay_devices where public_key = $1 or previous_public_key = $1`, [publicKey]);
      if (taken) return null;
      const [device] = await tx.query<DeviceRow>(
        `insert into relay_devices (owner_user_id, name, platform, public_key) values ($1, $2, $3, $4) returning *`,
        [code.owner_user_id, clean(hello.name, 80, 'Device'), clean(hello.platform, 24, 'unknown'), publicKey]);
      await tx.query(`update relay_pairing_codes set device_id = $2 where code_hash = $1`, [hash, device.id]);
      await appendEvent(tx, { actorUserId: code.owner_user_id, actor: 'user', kind: 'relay.device_paired', subjectType: 'relay_device', subjectId: device.id, payload: { platform: device.platform } });
      return device;
    };
    const device = this.db.transaction ? await this.db.transaction(work) : await work(this.db);
    if (!device) return { ok: false, error: 'bad_code' };
    void this.dropInvite(hello.code);
    void this.sync().catch(() => undefined);
    return device;
  }

  private noteSeen(device: string): void {
    const now = Date.now();
    if (now - (this.seen.get(device) ?? 0) < SEEN_WRITE_MS) return;
    this.seen.set(device, now);
    void this.db.query(`update relay_devices set last_seen_at = now() where id = $1`, [device]).catch(() => undefined);
  }

  async createPairing(ownerUserId: string): Promise<{ code: string; link: string | null; expiresAt: string }> {
    const row = await this.row();
    // A device finds the server through the relay the first time, even if it
    // goes direct after that. Without a relay, the server's own address still
    // works on your network, with no pairing.
    if (!row?.relay_enabled) throw new RelayError(409, 'Pairing needs the relay. Link a Connect plan or set up your own relay first.');
    const lan = this.lanAddresses(row);
    await this.keys();
    const code = newPairingCode();
    const expires = Math.floor(Date.now() / 1000) + PAIRING_TTL_SECONDS;
    const expiresAt = new Date(expires * 1000).toISOString();
    await this.db.query(`delete from relay_pairing_codes where expires_at < now() - interval '1 day'`);
    await this.db.query(`insert into relay_pairing_codes (code_hash, owner_user_id, expires_at) values ($1, $2, $3)`, [codeHash(code), ownerUserId, expiresAt]);
    const box: InviteBox = { v: 1, server: await this.publicKey(), site: row.site ?? '', relay: row.relay_url?.replace(/^http/, 'ws') ?? '', name: row.name, lan };
    if (row.relay_url && row.site) {
      const res = await this.relayFetch(row, `/v1/sites/${row.site}/invites/${inviteId(code)}`, {
        method: 'PUT', body: JSON.stringify({ box: sealInvite(code, box), expires, lookups: 5 }) });
      if (!res.ok) throw new RelayError(502, 'The relay did not take the pairing code. Try again.');
    }
    return { code: displayCode(code), link: this.addressOf(row) ? pairingLink(`https://${this.addressOf(row)}`, code, box) : null, expiresAt };
  }

  private async dropInvite(code: string): Promise<void> {
    const row = await this.row();
    if (row?.relay_enabled && row.relay_url && row.site) await this.relayFetch(row, `/v1/sites/${row.site}/invites/${inviteId(code)}`, { method: 'DELETE' }).catch(() => undefined);
  }

  async devices(ownerUserId: string | null): Promise<DeviceRow[]> {
    return ownerUserId
      ? this.db.query<DeviceRow>(`select * from relay_devices where owner_user_id = $1 order by paired_at desc`, [ownerUserId])
      : this.db.query<DeviceRow>(`select * from relay_devices order by paired_at desc`);
  }

  /** Revocation holds even if every message about it is lost: the row is what the
   * next handshake checks. Live sessions are cut here as well. */
  async revoke(device: string, actorUserId: string | null, opts: { announce?: boolean } = {}): Promise<boolean> {
    const rows = await this.db.query<{ id: string }>(
      `update relay_devices set revoked_at = now(), revoked_by = $2 where id = $1 and revoked_at is null returning id`, [device, actorUserId]);
    if (!rows.length) return false;
    this.host.disconnectDevice(device);
    this.bridge.forget(device);
    await appendEvent(this.db, { actorUserId, actor: actorUserId ? 'user' : 'system', kind: 'relay.device_revoked', subjectType: 'relay_device', subjectId: device });
    if (opts.announce !== false) void this.sync().catch(() => undefined);
    return true;
  }

  // ----------------------------------------------------------- hosted calls

  /** Only the hosted key this server pinned when it was linked gets past here. */
  private async hostedHello(hello: HostedHello, remote: Uint8Array): Promise<Record<string, unknown> | null> {
    const row = await this.row();
    if (!row?.hosted_public || !equal(fromB64url(row.hosted_public), remote)) return null;
    if (hello.op === 'revoke-device') return { ok: await this.revoke(hello.device, null) };
    if (hello.op === 'google-begin') return this.beginGoogle(hello.state);
    if (hello.op === 'google-tokens') return this.finishGoogle(hello);
    return null;
  }

  private master() {
    if (this.opts.masterKey === false) throw new RelayError(503, 'The installation key is unavailable.');
    return loadMasterKey(this.opts.masterKey ?? {});
  }

  private async beginGoogle(state: string): Promise<Record<string, unknown>> {
    const consumed = await createStateStore(this.db, this.master()).consume({ state, provider: 'google', sessionId: null });
    if (!consumed.ok) return { ok: false, error: consumed.reason };
    for (const [key, value] of this.handoffs) if (value.expires < Date.now()) this.handoffs.delete(key);
    this.handoffs.set(state, { handshake: consumed.handshake, expires: Date.now() + HANDOFF_TTL_MS });
    return { ok: true, verifier: consumed.handshake.verifier };
  }

  private async finishGoogle(hello: Extract<HostedHello, { op: 'google-tokens' }>): Promise<Record<string, unknown>> {
    const pending = this.handoffs.get(hello.state);
    this.handoffs.delete(hello.state);
    if (!pending || pending.expires < Date.now()) return { ok: false, error: 'expired' };
    const { handshake } = pending;
    let identity: { accountId: string | null; email: string | null } = { accountId: null, email: null };
    try { identity = await fetchIdentity('google', hello.accessToken, { fetchImpl: this.opts.connectorFetch }); } catch { /* a working connection isn't refused over this */ }
    await upsertConnection(this.db, this.master(), {
      ownerUserId: handshake.userId, provider: 'google',
      tokens: { accessToken: hello.accessToken, refreshToken: hello.refreshToken, expiresIn: hello.expiresIn, grantedScopes: hello.scope },
      accountEmail: identity.email, providerAccountId: identity.accountId, targetConnectionId: handshake.targetConnectionId,
      requestedCapabilities: handshake.capabilities, enableRequestedCapabilities: false, oauthClient: HEY_JOSI_CLIENT,
    });
    return { ok: true, returnPath: handshake.returnPath };
  }

  // ------------------------------------------------------------ the account

  async row(): Promise<LinkRow | null> {
    return (await this.db.query<LinkRow>('select * from hey_josi_link where id = true'))[0] ?? null;
  }

  private addressOf(row: LinkRow | null): string {
    if (!row?.name || !row.relay_url) return '';
    return `${row.name}.${new URL(row.relay_url).hostname.replace(/^relay\./, '')}`;
  }

  private lanAddresses(row: LinkRow | null): string[] {
    if (!this.lan || row?.lan_enabled === false) return [];
    return lanHosts().map(host => `ws://${host}:${this.lan!.port}${LAN_PATH}`);
  }

  private async relayFetch(row: LinkRow, path: string, init: RequestInit): Promise<Response> {
    const secret = await (await this.keyStore()).get(RELAY_SECRET);
    return (this.opts.fetchImpl ?? fetch)(`${row.relay_url!.replace(/\/$/, '')}${path}`, {
      ...init, signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', ...(secret ? { authorization: `Bearer ${secret}` } : {}) },
    });
  }

  private async hostedPublic(url: string): Promise<string> {
    if (this.opts.hostedPublicKey) return this.opts.hostedPublicKey;
    if (url === HOSTED_URL) return HOSTED_PUBLIC_KEY;
    const res = await (this.opts.fetchImpl ?? fetch)(`${url.replace(/\/$/, '')}/v1/noise-key`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new RelayError(502, 'heyjosi.com could not be reached.');
    return (await res.json() as { publicKey: string }).publicKey;
  }

  /** Links this server to an account with a code from the account page. */
  async linkAccount(args: { code: string; actorUserId: string }): Promise<LinkRow> {
    if (await this.row()) throw new RelayError(409, 'This server is already linked. Unlink it first.');
    const url = (this.opts.hostedUrl ?? HOSTED_URL).replace(/\/$/, '');
    const hostedPublic = await this.hostedPublic(url);
    const keys = await this.keys();
    const reply = await rpcCall<LinkReply>({ url, key: keys.current, hostedPublic: fromB64url(hostedPublic),
      call: { op: 'link', code: args.code, version: process.env.JOSI_VERSION ?? '0.1.0' }, fetchImpl: this.opts.fetchImpl });
    if (!reply.ok) throw new RelayError(400, reply.message ?? 'That code was wrong, used, or expired. Make a new one on your account page.');
    await this.db.query(
      `insert into hey_josi_link (hosted_url, hosted_public, server_id, site, name, relay_url, plan) values ($1, $2, $3, $4, $5, $6, $7)`,
      [url, hostedPublic, reply.serverId, reply.site, reply.name, reply.relayUrl, reply.plan]);
    await appendEvent(this.db, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'relay.account_linked' });
    await this.sync();
    return (await this.row())!;
  }

  /** For a relay you run yourself: no account, no plan, no heyjosi.com. */
  async useOwnRelay(args: { relayUrl: string; name: string | null; actorUserId: string }): Promise<LinkRow> {
    if (await this.row()) throw new RelayError(409, 'This server is already linked. Unlink it first.');
    let url: URL;
    try { url = new URL(args.relayUrl); } catch { throw new RelayError(400, 'Enter the relay\'s address, like https://relay.example.com.'); }
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new RelayError(400, 'The relay\'s address must be https.');
    const res = await (this.opts.fetchImpl ?? fetch)(`${url.origin}/v1/sites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args.name ? { name: args.name } : {}), signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new RelayError(502, 'That relay refused to register this server. It needs OPEN_RELAY set to 1.');
    const made = await res.json() as { site: string; secret: string; name: string | null };
    await (await this.keyStore()).set(RELAY_SECRET, made.secret);
    await this.db.query(`insert into hey_josi_link (site, name, relay_url, relay_enabled) values ($1, $2, $3, true)`, [made.site, made.name, url.origin]);
    await appendEvent(this.db, { actorUserId: args.actorUserId, actor: 'super_admin', kind: 'relay.own_relay_set' });
    await this.applyState();
    return (await this.row())!;
  }

  async unlink(actorUserId: string): Promise<void> {
    const row = await this.row();
    if (!row) return;
    if (row.hosted_url) await hostedCall(this.db, { op: 'unlink' }, { fetchImpl: this.opts.fetchImpl }).catch(() => undefined);
    if (row.relay_enabled && row.relay_url && row.site) await this.relayFetch(row, `/v1/sites/${row.site}/name`, { method: 'DELETE' }).catch(() => undefined);
    this.link?.stop(); this.link = null;
    const store = await this.keyStore();
    await store.delete(RELAY_SECRET);
    await store.delete(AI_TOKEN);
    await this.db.query('delete from hey_josi_link');
    await appendEvent(this.db, { actorUserId, actor: 'super_admin', kind: 'relay.account_unlinked' });
  }

  async setLan(enabled: boolean): Promise<void> {
    await this.db.query('update hey_josi_link set lan_enabled = $1', [enabled]);
    await this.applyState();
  }

  /** One at a time. Overlapping syncs could register with the relay twice, or
   * answer each other's revocations, and a caller that waits must see its own
   * sync finish with everything before it applied. */
  sync(): Promise<void> {
    const run = this.syncing.catch(() => undefined).then(() => this.syncOnce());
    this.syncing = run.catch(() => undefined);
    return run;
  }

  private async syncOnce(): Promise<void> {
    const row = await this.row();
    if (!row?.hosted_url) return;
    const rows = await this.devices(null);
    const devices: HostedDevice[] = rows.map(d => ({ id: d.id, name: d.name, platform: d.platform, pairedAt: d.paired_at, lastSeenAt: d.last_seen_at, revokedAt: d.revoked_at }));
    let reply;
    try {
      reply = await hostedCall<SyncReply>(this.db, { op: 'sync', devices, version: process.env.JOSI_VERSION ?? '0.1.0', lan: row.lan_enabled, refreshKey: await this.refreshKey() }, { fetchImpl: this.opts.fetchImpl });
    } catch (error) {
      await this.db.query('update hey_josi_link set last_sync_error = $1', [(error as Error).message]);
      throw error;
    }
    if (!reply.ok) { await this.db.query('update hey_josi_link set last_sync_error = $1', [reply.error]); throw new RelayError(502, reply.message ?? 'heyjosi.com refused the sync.'); }
    if (reply.aiToken) await (await this.keyStore()).set(AI_TOKEN, reply.aiToken);
    const enabled = reply.grant ? await this.applyGrant(row, reply.grant) : false;
    await this.db.query(
      `update hey_josi_link set plan = $1, name = $2, ai_base_url = $3, usage = $4, relay_enabled = $5, last_sync_at = now(), last_sync_error = null`,
      [reply.plan, reply.name, reply.aiBaseUrl, json(reply.usage), enabled]);
    for (const device of reply.revoke) await this.revoke(device, null, { announce: false });
    await this.applyState();
  }

  /** See brokeredRefresh. Only its public half ever leaves this server. */
  private async refreshKey(): Promise<string> {
    const [row] = await this.db.query<{ refresh_key_enc: string | null }>('select refresh_key_enc from hey_josi_link where id = true');
    if (row?.refresh_key_enc) return toB64url(staticKeyFrom(fromB64url(openSealed<{ privateKey: string }>(this.master(), row.refresh_key_enc).privateKey)).publicKey);
    const next = generateKeyPair();
    await this.db.query('update hey_josi_link set refresh_key_enc = $1', [seal(this.master(), { privateKey: toB64url(next.privateKey) })]);
    return toB64url(next.publicKey);
  }

  /** Registers with the relay the first time, renews after that. */
  private async applyGrant(row: LinkRow, grant: string): Promise<boolean> {
    const store = await this.keyStore();
    if (!await store.get(RELAY_SECRET)) {
      const res = await (this.opts.fetchImpl ?? fetch)(`${row.relay_url!.replace(/\/$/, '')}/v1/sites`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant }), signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new RelayError(502, 'The relay refused this server.');
      await store.set(RELAY_SECRET, (await res.json() as { secret: string }).secret);
      return true;
    }
    const res = await this.relayFetch(row, `/v1/sites/${row.site}/grant`, { method: 'POST', body: JSON.stringify({ grant }) });
    if (!res.ok) throw new RelayError(502, 'The relay refused to renew this server.');
    return true;
  }

  /** Brings the running listeners in line with the row. Safe to call any time. */
  private async applyState(): Promise<void> {
    const row = await this.row();
    await this.keys();
    this.address = this.addressOf(row);
    if (row?.relay_enabled && row.site && row.relay_url) {
      if (!this.link) {
        const store = await this.keyStore();
        const secret = await store.get(RELAY_SECRET);
        if (secret) {
          this.link = new RelayLink({ url: row.relay_url, site: row.site, secret: () => secret, host: this.host });
          this.link.start();
        }
      }
    } else if (this.link) { this.link.stop(); this.link = null; }
    const wantLan = !!row && row.lan_enabled && this.opts.lanPort !== null;
    if (wantLan && !this.lan) {
      this.lan = await lanListener(this.host, { port: this.opts.lanPort ?? DEFAULT_LAN_PORT }).catch(error => { console.error(`josi-ce: LAN path unavailable: ${(error as Error).message}`); return null; });
    } else if (!wantLan && this.lan) { await this.lan.close(); this.lan = null; }
  }

  async start(): Promise<void> {
    await this.applyState();
    void this.sync().catch(() => undefined);
    this.timer ??= setInterval(() => { void this.sync().catch(() => undefined); }, SYNC_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.link?.stop(); this.link = null;
    await this.lan?.close(); this.lan = null;
  }

  async status() {
    const row = await this.row();
    const store = await this.keyStore();
    const keys = await this.keys();
    return {
      linked: !!row?.hosted_url,
      ownRelay: !!row && !row.hosted_url,
      plan: row?.plan ?? 'free',
      address: this.addressOf(row) || null,
      relay: { enabled: !!row?.relay_enabled, state: this.link?.state ?? 'stopped', error: this.link?.lastError ?? null },
      lan: { enabled: row?.lan_enabled ?? false, addresses: this.lanAddresses(row) },
      keyStore: store.kind,
      publicKey: toB64url(keys.current.publicKey),
      keyOverlapUntil: keys.previous ? new Date(keys.previousUntil).toISOString() : null,
      connected: this.host.connected(),
      lastSyncAt: row?.last_sync_at ?? null,
      lastSyncError: row?.last_sync_error ?? null,
      usage: row?.usage ?? null,
      aiReady: !!await store.get(AI_TOKEN),
      aiBaseUrl: row?.ai_base_url ?? null,
    };
  }

  async aiToken(): Promise<string | null> { return (await this.keyStore()).get(AI_TOKEN); }
}
