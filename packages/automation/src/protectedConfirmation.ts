import { createHash, verify, type KeyObject } from 'node:crypto';
import { parseProtectedControlChallenge, protectedControlMessage, isProtectedControlOrigin,
  type ProtectedControlChallenge, type ProtectedControlReceipt } from '@josi-ce/protocol';

export interface ProtectedConfirmationPorts {
  loadChallenge(id: string, signal: AbortSignal): Promise<unknown>;
  /** Trusted HOST presentation only; remote content is rendered as plain text.
   * Call cancel on local closure/cancellation even AFTER review or OS presence
   * resolves, until signal aborts at the end of the entire confirmation. */
  present(challenge: Readonly<ProtectedControlChallenge>, signal: AbortSignal, cancel: () => void): Promise<boolean>;
  /** Genuine local OS authentication, not an approval boolean from a renderer.
   * Missing/unsupported authentication must reject; no dialog-only fallback. */
  authenticate(challenge: Readonly<ProtectedControlChallenge>, signal: AbortSignal): Promise<void>;
  /** Resolve current Vault authority on the authenticated connection. */
  isCurrent(challenge: Readonly<ProtectedControlChallenge>, signal: AbortSignal): Promise<boolean>;
  /** A minimized one-use Vault-issued runtime key projection. This port must
   * check current authority/expiry before signing this exact message and dispose
   * of its lease afterwards. No general signing IPC or persistent local key. */
  sign(challenge: Readonly<ProtectedControlChallenge>, message: Uint8Array, signal: AbortSignal): Promise<string>;
  clock?: () => { wallMs: number; monotonicMs: number };
}
export type ProtectedConfirmationResult = { status: 'confirmed'; receipt: ProtectedControlReceipt }
  | { status: 'refused'; code: 'busy' | 'invalid_challenge' | 'cancelled' | 'unavailable_or_stale' };
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
function immutable(challenge: ProtectedControlChallenge): Readonly<ProtectedControlChallenge> {
  const copy = structuredClone(challenge);
  Object.freeze(copy.keyReference); Object.freeze(copy.presentation.advisory); Object.freeze(copy.presentation);
  return Object.freeze(copy);
}

/** Returns only a signed one-use challenge receipt. Does not activate a rule,
 * replace fresh server reauthentication, enroll a key or implement a verifier. */
export function createProtectedConfirmationBroker(identity: { serverOrigin: string; serverId: string; userId: string; deviceId: string }, ports: ProtectedConfirmationPorts) {
  if (!isProtectedControlOrigin(identity?.serverOrigin) || ![identity.serverId, identity.userId, identity.deviceId].every(uuid)
    || ['loadChallenge', 'present', 'authenticate', 'isCurrent', 'sign'].some(k => typeof ports?.[k as keyof ProtectedConfirmationPorts] !== 'function')) throw new Error('A protected host confirmation boundary is required.');
  const boundIdentity = structuredClone(identity), clock = ports.clock ?? (() => ({ wallMs: Date.now(), monotonicMs: performance.now() }));
  let generation = 0, flight: AbortController | null = null;
  const consumed = new Set<string>();
  const cancel = () => { generation += 1; flight?.abort(); };
  return Object.freeze({
    cancel,
    async confirm(id: string): Promise<ProtectedConfirmationResult> {
      if (flight) return { status: 'refused', code: 'busy' };
      if (!uuid(id) || consumed.has(id) || consumed.size >= 4096) return { status: 'refused', code: 'invalid_challenge' };
      const controller = new AbortController(), ownGeneration = generation; flight = controller;
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const aborted = new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
        // A stalled source cannot hold this host's confirmation queue forever.
        timer = setTimeout(() => controller.abort(), 120_000); timer.unref();
        const loaded = await Promise.race([ports.loadChallenge(id, controller.signal), aborted]);
        const challenge = parseProtectedControlChallenge(loaded), start = clock();
        if (!challenge || challenge.id !== id || challenge.serverOrigin !== boundIdentity.serverOrigin || challenge.serverId !== boundIdentity.serverId
          || challenge.userId !== boundIdentity.userId || challenge.deviceId !== boundIdentity.deviceId
          || !Number.isSafeInteger(start.wallMs) || !Number.isFinite(start.monotonicMs) || start.monotonicMs < 0
          || challenge.issuedAtMs > start.wallMs || challenge.expiresAtMs <= start.wallMs) return { status: 'refused', code: 'invalid_challenge' };
        clearTimeout(timer); timer = setTimeout(() => controller.abort(), challenge.expiresAtMs - start.wallMs); timer.unref();
        const endMono = start.monotonicMs + challenge.expiresAtMs - start.wallMs;
        let previous = start;
        const live = () => {
          const now = clock();
          if (controller.signal.aborted || ownGeneration !== generation || !Number.isSafeInteger(now.wallMs) || !Number.isFinite(now.monotonicMs)
            || now.wallMs < previous.wallMs || now.monotonicMs < previous.monotonicMs || now.wallMs >= challenge.expiresAtMs || now.monotonicMs >= endMono) throw new Error('expired');
          previous = now;
        };
        const current = async () => {
          live();
          if (await Promise.race([ports.isCurrent(immutable(challenge), controller.signal), aborted]) !== true) throw new Error('stale');
          live();
        };
        await current();
        // Consume before showing it: closing/cancelling a prompt requires a
        // fresh server challenge, not silent resubmission of an old approval.
        consumed.add(id);
        if (await Promise.race([ports.present(immutable(challenge), controller.signal, () => controller.abort()), aborted]) !== true) return { status: 'refused', code: 'cancelled' };
        await current();
        const authenticated = await Promise.race([ports.authenticate(immutable(challenge), controller.signal), aborted]);
        if (authenticated !== undefined) throw new Error('invalid authentication result');
        await current();
        const message = Buffer.from(protectedControlMessage(challenge), 'utf8');
        const signature = await Promise.race([ports.sign(immutable(challenge), Buffer.from(message), controller.signal), aborted]);
        if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, 'base64url').length !== 64
          || Buffer.from(signature, 'base64url').toString('base64url') !== signature) throw new Error('invalid signature');
        await current();
        return { status: 'confirmed', receipt: { schemaVersion: 1, challengeId: id,
          challengeDigest: createHash('sha256').update(message).digest('hex'), signature } };
      } catch { return { status: 'refused', code: 'unavailable_or_stale' }; }
      finally { if (timer) clearTimeout(timer); controller.abort(); if (flight === controller) flight = null; }
    },
  });
}

/** Cryptographic check only. Server code MUST additionally load the current
 * enrolled key from the Vault, check role/session/epoch/expiry, match the exact
 * fresh administrator command and atomically consume the server challenge. */
export function verifyProtectedControlSignature(challenge: ProtectedControlChallenge, receipt: ProtectedControlReceipt, publicKey: KeyObject): boolean {
  try {
    if (!receipt || Object.keys(receipt).sort().join(',') !== 'challengeDigest,challengeId,schemaVersion,signature'
      || receipt.schemaVersion !== 1 || receipt.challengeId !== challenge.id || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519'
      || typeof receipt.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(receipt.signature)) return false;
    const message = Buffer.from(protectedControlMessage(challenge), 'utf8'), signature = Buffer.from(receipt.signature, 'base64url');
    return signature.length === 64 && signature.toString('base64url') === receipt.signature
      && createHash('sha256').update(message).digest('hex') === receipt.challengeDigest && verify(null, message, publicKey, signature);
  } catch { return false; }
}
