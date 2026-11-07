// One-time codes that carry a sign-in finished in a browser back to a native app.
//
// The browser never holds a session for the app. It gets a code that lasts two
// minutes and is stored only as a hash, and the app redeems that code for a
// session of its own.
import { createHash, randomBytes } from 'node:crypto';
import { appendEvent, type Db } from '@josi-ce/core';

export function nativeCallback(returnUri: string, params: Record<string, string>): string {
  const url = new URL(returnUri);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

export async function issueNativeCode(db: Db, userId: string, eventKind: string): Promise<string> {
  const code = randomBytes(32).toString('base64url');
  await db.query(
    `insert into auth_native_codes (code_hash, user_id, expires_at)
     values ($1, $2, now() + interval '2 minutes')`,
    [createHash('sha256').update(code).digest('hex'), userId],
  );
  await appendEvent(db, { actorUserId: userId, actor: 'user', kind: eventKind, subjectType: 'user', subjectId: userId });
  return code;
}
