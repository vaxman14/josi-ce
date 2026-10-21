import { expect, it, vi } from 'vitest';
import { testDb, testVault } from '../../../packages/core/test/helpers.js';
import { MasterKey } from '@josi-ce/core';
import { createUser, createSession } from '@josi-ce/auth';
import { DeviceEnrollments } from '../src/http/deviceEnrollments.js';

it('prepares enrollment using the persisted install_identity without creating a device or granting control', async () => {
  const db = await testDb(), key = new MasterKey(Buffer.alloc(32, 19));
  const user = await createUser(db, { email: 'device@example.test', username: 'device', role: 'super_admin' });
  await testVault(db, key);
  const session = await createSession(db, { userId: user.id });
  const enrollments = new DeviceEnrollments(db, () => key, 'http://localhost:8080');
  // Only the platform helper availability is synthetic. Identity and session
  // resolution execute against the production migration schema.
  vi.spyOn(enrollments, 'available').mockResolvedValue(true);
  const [installed] = await db.query<{ install_id: string }>('select install_id from install_identity where id=true');
  const attempt = await enrollments.begin(user.id, session.sessionId, 'Test Mac');
  expect(attempt.identity.serverId).toBe(installed.install_id);
  expect(attempt.identity.userId).toBe(user.id);
  expect(await db.query("select id from vault_record_heads where kind='protected_devices'")).toEqual([]);
  expect(enrollments.cancel(user.id, session.sessionId, attempt.attemptId)).toEqual({ cancelled: true });
});
