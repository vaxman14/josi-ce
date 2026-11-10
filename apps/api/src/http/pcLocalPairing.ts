// Pairs the Linux server's own PC executor with the owner (see
// packages/core/src/pcLocalExecutors.ts for the handoff). Only ever called
// after the owner confirmed their password: from the PC Control page's Pair
// button, or from the chat card that turns control on for a linux- PC.
import { createSession } from '@josi-ce/auth';
import { localExecutorHello, writeLocalTicket, type Db } from '@josi-ce/core';

/** The executor's session lasts a year; unpairing or a new key revokes it. */
const EXECUTOR_SESSION_SECONDS = 365 * 24 * 60 * 60;
const AGENT = 'Josi PC service (Linux)';

export async function localExecutorPaired(db: Db, owner: string, pcId: string): Promise<boolean> {
  const hello = localExecutorHello(pcId); if (!hello) return false;
  const [identity] = await db.query<{ public_key: string }>('select public_key from pc_executor_identity where owner_user_id=$1 and pc_id=$2', [owner, pcId]);
  return identity?.public_key === hello.publicKey;
}

/** Records the hello's key as the PC's identity and hands the executor a
 * session. Returns false when no such executor said hello on this server. */
export async function pairLocalExecutor(db: Db, owner: string, pcId: string): Promise<boolean> {
  const hello = localExecutorHello(pcId);
  if (!hello) return false;
  await db.query('insert into pc_control_settings(owner_user_id,pc_id) values($1,$2) on conflict do nothing', [owner, pcId]);
  // A reinstalled executor has a new key: the owner's password replaces the
  // old identity, and the old executor sessions stop working.
  await db.query('delete from pc_executor_identity where owner_user_id=$1 and pc_id=$2 and public_key<>$3', [owner, pcId, hello.publicKey]);
  await db.query('insert into pc_executor_identity(owner_user_id,pc_id,public_key) values($1,$2,$3) on conflict do nothing', [owner, pcId, hello.publicKey]);
  await revokeExecutorSessions(db, owner, pcId);
  const { token } = await createSession(db, { userId: owner, userAgent: `${AGENT} ${pcId}`, ttlSeconds: EXECUTOR_SESSION_SECONDS });
  writeLocalTicket(pcId, { ownerId: owner, sessionToken: token, publicKey: hello.publicKey });
  return true;
}

export async function revokeExecutorSessions(db: Db, owner: string, pcId: string): Promise<void> {
  await db.query(`update sessions set revoked_at=now() where user_id=$1 and user_agent=$2 and revoked_at is null`, [owner, `${AGENT} ${pcId}`]);
}
