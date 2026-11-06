// How a server talks to the hosted accounts service: one Noise IK exchange per
// call, carried over HTTPS as a single POST. The call rides in handshake message
// one and the answer in message two, so whatever fronts the hosted service
// (Cloudflare, here) sees sealed bytes, and the hosted side knows which server is
// calling from the key the handshake proved, with no bearer token to lose.
import { randomBytes, toHex, utf8 } from './bytes.js';
import { Handshake, type StaticKey } from './noise.js';
import { decodeJson, encodeJson } from './protocol.js';

const RPC_PROLOGUE = utf8('josi-rpc/1');
export const RPC_SKEW_MS = 120_000;
export const RPC_PATH = '/v1/rpc';

export interface RpcEnvelope { v: 1; op: string; ts: number; nonce: string }

export interface HostedDevice { id: string; name: string; platform: string; pairedAt: string; lastSeenAt: string | null; revokedAt: string | null }

export interface HostedUsage {
  plan: 'free' | 'connect' | 'connect_ai';
  periodEnd: string | null;
  /** Micro-dollars. */
  allowance: number; topUps: number; spent: number; reserved: number; remaining: number;
  accountCap: number | null; accountSpent: number;
  models: Array<{ id: string; label: string; multiplier: number; default: boolean }>;
}

export type HostedCall =
  | { op: 'link'; code: string; version: string }
  | { op: 'sync'; devices: HostedDevice[]; version: string; lan: boolean }
  | { op: 'rotate-key'; publicKey: string }
  | { op: 'unlink' }
  | { op: 'google.authorize'; state: string; codeChallenge: string; scopes: string }
  | { op: 'google.refresh'; refreshToken: string; scopes: string };

export type HostedReply<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string; message?: string };

export interface LinkReply { serverId: string; site: string; name: string; hostedPublic: string; relayUrl: string; plan: HostedUsage['plan'] }
export interface SyncReply {
  plan: HostedUsage['plan'];
  name: string;
  /** Present while the plan includes the relay. */
  grant: string | null;
  /** Present once, right after the plan gains AI or the token is reset. */
  aiToken: string | null;
  aiBaseUrl: string | null;
  usage: HostedUsage;
  /** Devices someone revoked on the account page. */
  revoke: string[];
}

/** Calls that reach a server from the hosted side, as tunnel hellos. Only
 * accepted from the hosted key pinned when the server was linked. */
export type HostedHello =
  | { v: 1; op: 'google-begin'; state: string; ts: number }
  | { v: 1; op: 'google-tokens'; state: string; accessToken: string; refreshToken: string | null; expiresIn: number | null; scope: string; ts: number }
  | { v: 1; op: 'revoke-device'; device: string; ts: number };

export async function rpcCall<T>(args: {
  url: string; key: StaticKey; hostedPublic: Uint8Array; call: HostedCall; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<HostedReply<T>> {
  const handshake = new Handshake(true, args.key, args.hostedPublic, RPC_PROLOGUE);
  const envelope = { v: 1, ts: Date.now(), nonce: toHex(randomBytes(16)), ...args.call };
  const body = await handshake.writeFirst(encodeJson(envelope));
  const res = await (args.fetchImpl ?? fetch)(`${args.url.replace(/\/$/, '')}${RPC_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: body as Uint8Array<ArrayBuffer>,
    signal: AbortSignal.timeout(args.timeoutMs ?? 20_000),
  });
  if (!res.ok) return { ok: false, error: `hosted_${res.status}` };
  return decodeJson<HostedReply<T>>(await handshake.readSecond(new Uint8Array(await res.arrayBuffer())));
}

/** The hosted side. `seen` refuses a replayed message: anyone holding the HTTPS
 * bytes could resend them, though never read them. */
export async function rpcAnswer(args: {
  key: StaticKey; message: Uint8Array; seen(nonce: string): boolean | Promise<boolean>;
  handle(call: HostedCall & RpcEnvelope, caller: Uint8Array): Promise<Record<string, unknown>>;
}): Promise<Uint8Array> {
  const handshake = new Handshake(false, args.key, null, RPC_PROLOGUE);
  const call = decodeJson<HostedCall & RpcEnvelope>(await handshake.readFirst(args.message));
  let reply: Record<string, unknown>;
  if (call.v !== 1 || Math.abs(Date.now() - Number(call.ts)) > RPC_SKEW_MS || typeof call.nonce !== 'string' || await args.seen(call.nonce)) reply = { ok: false, error: 'stale' };
  else reply = await args.handle(call, handshake.remoteStatic!);
  return handshake.writeSecond(encodeJson(reply));
}
