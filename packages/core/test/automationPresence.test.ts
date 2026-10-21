import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, testVault } from './helpers.js';
import { MasterKey } from '../src/masterKey.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { listAutomationPresence, openAutomationPresence, renewAutomationPresence } from '../src/automationPresence.js';
import { createNativeInspectionRuntime } from '../src/nativeAutomationRuntime.js';

it('discovers real-schema workspace presence using the existing installation identity, without granting control', async () => {
  const db = await testDb(), key = new MasterKey(Buffer.alloc(32, 17));
  const user = await createUser(db, { email: 'presence@example.test', username: 'presence', role: 'super_admin' });
  await testVault(db, key);
  const session = await createSession(db, { userId: user.id });
  const runtime = createNativeInspectionRuntime(db, key);
  expect(await runtime.inventory(user.id)).toEqual([]);
  const [installation] = await db.query<{ install_id: string }>('select install_id from install_identity where id=true');
  const storage = randomUUID(), workspace = randomUUID();
  const identity = { userId: user.id, deviceId: randomUUID(), workspaceId: workspace, serverId: installation.install_id };
  await openAutomationPresence(db, { identity, storageSessionId: storage, authSessionId: session.sessionId,
    authorityEpoch: 1, label: 'Test desktop', leaseUntilMs: Date.now() + 9000 });
  await renewAutomationPresence(db, { ownerUserId: user.id, authSessionId: session.sessionId, storageSessionId: storage,
    leaseUntilMs: Date.now() + 9000, report: { machineState: 'running', companionConnected: true } });
  expect(await listAutomationPresence(db, user.id)).toEqual([{ identity, label: 'Test desktop', isolated: true,
    state: 'needs_local_consent', computerUse: false, browserFamilies: [] }]);
  expect((await runtime.inventory(user.id))[0].state).toBe('needs_local_consent');
  await db.query('update automation_workspace_presence set server_id=$1 where workspace_id=$2', [randomUUID(), workspace]);
  expect(await runtime.inventory(user.id)).toEqual([]);
});
