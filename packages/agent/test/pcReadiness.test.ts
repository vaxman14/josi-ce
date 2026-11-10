import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { MasterKey, PcControl } from '@josi-ce/core';
import { pcControlReadiness, pcPermissionState } from '../src/pcPermissionSettings.js';

// Every link of the chain from a chat request to work on the PC, named. The
// owner read "I can't do that" for days because nothing said which link was
// missing; this is what replaces the guessing.
let db: TestDb, owner: string;
const key = new MasterKey(Buffer.alloc(32, 9));
beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, { email: 'ready@ce.test', username: 'ready', role: 'super_admin' })).id;
});
async function model(toolCalling: boolean | null, probed = true) {
  await db.query(`delete from llm_providers`);
  // An unprobed model is never active (schema rule llm_active_requires_probe).
  await db.query(`insert into llm_providers(role,provider,model,external_acknowledged,activated_at,probed_at,cap_chat,cap_structured_output,cap_tool_calling,cap_vision,cap_context_tokens)
    values('primary','anthropic_subscription','haiku',true,${probed ? 'now()' : 'null'},${probed ? 'now()' : 'null'},true,true,$1,false,8000)`, [toolCalling]);
}

describe('PC control readiness', () => {
  it('names every missing link on a fresh account', async () => {
    const r = await pcControlReadiness(db, owner);
    expect(r.ready).toBe(false);
    expect(r.facts.model.ok).toBe(false);
    expect(r.facts.pcRegistered.ok).toBe(false);
    expect(r.facts.pcRegistered.detail).toMatch(/Open Josi on the PC/);
    expect(r.summary).toMatch(/Not ready/);
  });
  it('tells the owner the model cannot call tools instead of letting the chat refuse vaguely', async () => {
    await model(false);
    const r = await pcControlReadiness(db, owner);
    expect(r.facts.model.ok).toBe(false);
    expect(r.facts.model.detail).toMatch(/haiku/);
    expect(r.facts.model.detail).toMatch(/tool-calling check/);
    await model(null, false);
    expect((await pcControlReadiness(db, owner)).facts.model.detail).toMatch(/not been checked/);
  });
  it('walks the links as the PC registers, pairs, is enabled and announces itself', async () => {
    await model(true);
    const control = new PcControl(db, key, 'win-one');
    await control.register(owner);
    let r = await pcControlReadiness(db, owner);
    expect(r.facts.pcRegistered.ok).toBe(true);
    expect(r.facts.pcPaired.ok).toBe(false);
    expect(r.facts.pcPaired.detail).toMatch(/Approve This PC/);
    expect(r.facts.controlEnabled.ok).toBe(false);
    // Chat can see and select the registered, unpaired PC.
    const state = await pcPermissionState(db, owner, key);
    expect(state.devices).toEqual([{ pcId: 'win-one', enabled: false, connected: false, paired: false }]);
    expect(state.selected?.pcId).toBe('win-one');
    await db.query(`insert into pc_executor_identity(owner_user_id,pc_id,public_key) values($1,'win-one','key')`, [owner]);
    await control.setEnabled(owner, true);
    r = await pcControlReadiness(db, owner);
    expect(r.facts.pcPaired.ok).toBe(true);
    expect(r.facts.controlEnabled.ok).toBe(true);
    expect(r.facts.pcPresence.ok).toBe(false);
    expect(r.facts.pcPresence.detail).toMatch(/not announcing/);
    await control.setPresence(owner, { family: 'desktop', application: 'C:\\Josi\\Josi.exe', profile: 'Default', origin: null, title: null });
    r = await pcControlReadiness(db, owner);
    expect(r.ready).toBe(true);
    expect(r.summary).toMatch(/Ready/);
    expect(r.facts.grants.detail).toMatch(/0 saved allowance/);
  });
});
