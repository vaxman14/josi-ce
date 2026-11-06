// Passkeys: who owns which key, and the challenges that prove a response is fresh.
import { createHash, randomBytes } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';
import { COSE_EDDSA, COSE_ES256, COSE_RS256, WebAuthnError, base64url, claimedChallenge, fromBase64url, verifyAssertion, verifyRegistration } from './webauthn.js';

const CHALLENGE_TTL_SECONDS = 5 * 60;
const MAX_CHALLENGES_PER_IP = 30;

export interface RelyingParty { id: string; origin: string; name: string }

export interface Passkey { id: string; name: string; created_at: string; last_used_at: string | null }

/** Browsers offer WebAuthn on https or on localhost, and only on a name: never
 * on a bare IP address. So an install reached any other way has no passkeys,
 * and the sign-in page simply does not show the button. */
export function relyingParty(appUrl: string): RelyingParty | null {
  let url: URL;
  try { url = new URL(appUrl); } catch { return null; }
  const host = url.hostname;
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.startsWith('[');
  if (isIp || (url.protocol !== 'https:' && host !== 'localhost')) return null;
  return { id: host, origin: url.origin, name: 'Josi' };
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const userHandle = (userId: string) => base64url(Buffer.from(userId.replace(/-/g, ''), 'hex'));

async function issueChallenge(db: Db, purpose: 'register' | 'login', userId: string | null, ip: string | null): Promise<string> {
  await db.query(`delete from auth_passkey_challenges where expires_at < now() - interval '1 day'`);
  if (ip) {
    const [recent] = await db.query<{ n: number }>(`select count(*)::int n from auth_passkey_challenges where ip = $1 and created_at > now() - interval '10 minutes'`, [ip]);
    if ((recent?.n ?? 0) >= MAX_CHALLENGES_PER_IP) throw new WebAuthnError('Too many passkey attempts. Try again in a few minutes.');
  }
  const challenge = randomBytes(32).toString('base64url');
  await db.query(
    `insert into auth_passkey_challenges (challenge_hash, purpose, user_id, ip, expires_at) values ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
    [digest(challenge), purpose, userId, ip, CHALLENGE_TTL_SECONDS],
  );
  return challenge;
}

/** Spends a challenge: once, unexpired, for this purpose and this person. */
async function spendChallenge(db: Db, challenge: string, purpose: 'register' | 'login', userId: string | null): Promise<void> {
  const spent = await db.query(
    `update auth_passkey_challenges set used_at = now()
     where challenge_hash = $1 and purpose = $2 and used_at is null and expires_at > now() and user_id is not distinct from $3
     returning challenge_hash`,
    [digest(challenge), purpose, userId],
  );
  if (!spent.length) throw new WebAuthnError('That passkey request expired. Try again.');
}

export async function beginPasskeyRegistration(db: Db, rp: RelyingParty, user: { id: string; email: string; username: string; display_name?: string | null }, ip: string | null) {
  const existing = await db.query<{ credential_id: string; transports: string[] }>(`select credential_id, transports from auth_passkeys where user_id = $1`, [user.id]);
  return {
    challenge: await issueChallenge(db, 'register', user.id, ip),
    rp: { id: rp.id, name: rp.name },
    user: { id: userHandle(user.id), name: user.email, displayName: user.display_name || user.username },
    pubKeyCredParams: [COSE_ES256, COSE_EDDSA, COSE_RS256].map(alg => ({ type: 'public-key', alg })),
    timeout: CHALLENGE_TTL_SECONDS * 1000,
    attestation: 'none',
    authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
    excludeCredentials: existing.map(key => ({ type: 'public-key', id: key.credential_id, transports: key.transports })),
  };
}

export async function finishPasskeyRegistration(db: Db, rp: RelyingParty, userId: string, input: { clientDataJSON: unknown; attestationObject: unknown; transports?: unknown; name: unknown }): Promise<Passkey> {
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '';
  if (!name || /[\u0000-\u001f\u007f]/.test(name)) throw new WebAuthnError('Give this passkey a name.');
  const challenge = claimedChallenge(input.clientDataJSON);
  await spendChallenge(db, challenge, 'register', userId);
  const verified = verifyRegistration({ clientDataJSON: input.clientDataJSON, attestationObject: input.attestationObject }, { challenge, origin: rp.origin, rpId: rp.id });
  const transports = Array.isArray(input.transports) ? input.transports.filter((t): t is string => typeof t === 'string' && /^[a-z-]{1,32}$/.test(t)).slice(0, 8) : [];
  const [saved] = await db.query<Passkey>(
    `insert into auth_passkeys (user_id, credential_id, public_key, algorithm, sign_count, transports, name)
     values ($1, $2, $3, $4, $5, $6, $7) on conflict (credential_id) do nothing
     returning id, name, created_at, last_used_at`,
    [userId, verified.credentialId, verified.publicKey, verified.algorithm, verified.signCount, transports, name],
  );
  if (!saved) throw new WebAuthnError('That passkey is already in use.');
  await appendEvent(db, { actorUserId: userId, actor: 'user', kind: 'auth.passkey_added', subjectType: 'user', subjectId: userId, payload: { passkey: saved.id } });
  return saved;
}

export async function beginPasskeyLogin(db: Db, rp: RelyingParty, ip: string | null) {
  // No allowCredentials: the browser offers whatever passkeys it holds for this
  // server, so nothing here reveals whether any account has one.
  return {
    challenge: await issueChallenge(db, 'login', null, ip),
    rpId: rp.id,
    userVerification: 'required',
    timeout: CHALLENGE_TTL_SECONDS * 1000,
    allowCredentials: [],
  };
}

/** Returns the person who proved they hold this key, or throws. */
export async function finishPasskeyLogin(db: Db, rp: RelyingParty, input: { credentialId: unknown; clientDataJSON: unknown; authenticatorData: unknown; signature: unknown; userHandle?: unknown }): Promise<string> {
  const challenge = claimedChallenge(input.clientDataJSON);
  await spendChallenge(db, challenge, 'login', null);
  const credentialId = fromBase64url(input.credentialId, 'credentialId').toString('base64url');
  const [key] = await db.query<{ id: string; user_id: string; public_key: string; algorithm: number; sign_count: string }>(
    `select k.id, k.user_id, k.public_key, k.algorithm, k.sign_count
     from auth_passkeys k join users u on u.id = k.user_id
     where k.credential_id = $1 and u.status = 'active'`,
    [credentialId],
  );
  if (!key) throw new WebAuthnError('That passkey is not registered here.');
  if (input.userHandle != null && input.userHandle !== '' && input.userHandle !== userHandle(key.user_id)) throw new WebAuthnError('That passkey belongs to someone else.');
  const signCount = verifyAssertion(
    { clientDataJSON: input.clientDataJSON, authenticatorData: input.authenticatorData, signature: input.signature },
    { challenge, origin: rp.origin, rpId: rp.id },
    { publicKey: key.public_key, algorithm: key.algorithm, signCount: Number(key.sign_count) },
  );
  // Conditional, so two racing sign-ins cannot both move the counter forward.
  const moved = await db.query(
    `update auth_passkeys set sign_count = $2, last_used_at = now() where id = $1 and (sign_count < $2 or (sign_count = 0 and $2 = 0)) returning id`,
    [key.id, signCount],
  );
  if (!moved.length) throw new WebAuthnError('This passkey may have been copied.');
  return key.user_id;
}

export async function listPasskeys(db: Db, userId: string): Promise<Passkey[]> {
  return db.query<Passkey>(`select id, name, created_at, last_used_at from auth_passkeys where user_id = $1 order by created_at`, [userId]);
}

export async function removePasskey(db: Db, userId: string, id: string): Promise<boolean> {
  const removed = await db.query(`delete from auth_passkeys where id = $1 and user_id = $2 returning id`, [id, userId]);
  if (removed.length) await appendEvent(db, { actorUserId: userId, actor: 'user', kind: 'auth.passkey_removed', subjectType: 'user', subjectId: userId, payload: { passkey: id } });
  return removed.length > 0;
}
