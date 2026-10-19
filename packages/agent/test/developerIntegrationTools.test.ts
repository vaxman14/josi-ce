import { MasterKey, setVaultLock } from '@josi-ce/core';
import { saveDeveloperConnection } from '@josi-ce/connectors';
import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { developerIntegrationToolAvailability, executeDeveloperIntegrationTool, executeDeveloperResourceTool } from '../src/developerIntegrationTools.js';
import { TOOL_SPECS_BY_NAME } from '../src/tools.js';

let db:TestDb;let owner:string;let other:string;
beforeEach(async()=>{db=await testDb();owner=(await createUser(db,{email:'native-owner@test.invalid',username:'nativeowner',role:'member'})).id;other=(await createUser(db,{email:'native-other@test.invalid',username:'nativeother',role:'member'})).id;await db.query(`insert into developer_connections(owner_user_id,service,credentials_enc,account_label,status,last_check_at,last_check_ok) values($1,'gitlab','sealed-never-return','git-user','active',now(),true),($2,'notion','other-secret','other workspace','active',now(),true)`,[owner,other]);});

describe('native integration assistant status',()=>{
  it('is offered only to an owner with a connection and is registered read-only',async()=>{
    expect(await developerIntegrationToolAvailability(db,owner)).toHaveLength(2);
    expect(TOOL_SPECS_BY_NAME.get('list_native_integrations')?.actionClass).toBeNull();
    expect(TOOL_SPECS_BY_NAME.get('list_native_resources')?.actionClass).toBeNull();
  });
  it('returns provider identity and capability without credentials or another user',async()=>{
    const result=await executeDeveloperIntegrationTool(db,owner);
    expect(result.integrations).toHaveLength(1);
    expect(result.integrations[0]).toMatchObject({provider:'gitlab',account:'git-user',healthy:true});
    expect(JSON.stringify(result)).not.toContain('sealed-never-return');
    expect(JSON.stringify(result)).not.toContain('other workspace');
  });
});


const key = new MasterKey(Buffer.alloc(32, 72));
describe('native resource credential dispatch', () => {
  beforeEach(async () => {
    await testVault(db, key);
    await db.query("update developer_service_policy set mode='everyone' where service='github'");
    await saveDeveloperConnection(db, key, { ownerUserId: owner, service: 'github', credentials: { token: 'synthetic-token' }, accountLabel: 'Fixture' });
  });
  it('does not call the provider or poison health when the Vault box is locked', async () => {
    await setVaultLock(db, { ownerUserId: owner, locked: true, actorUserId: owner });
    let calls = 0;
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'github' }, { masterKey: () => key, fetchImpl: async () => { calls++; return new Response('[]'); } });
    expect(result.ok).toBe(false); expect(calls).toBe(0);
    expect((await db.query("select last_check_ok from developer_connections where owner_user_id=$1 and service='github'", [owner]))[0].last_check_ok).toBe(true);
  });
  it('discards results when the connection rotates during discovery', async () => {
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'github' }, { masterKey: () => key, fetchImpl: async () => {
      await saveDeveloperConnection(db, key, { ownerUserId: owner, service: 'github', credentials: { token: 'replacement-token' }, accountLabel: 'Replacement' });
      return new Response(JSON.stringify([{ id: 1, full_name: 'fixture/repo' }]));
    } });
    expect(result.ok).toBe(false);
    expect((await db.query("select account_label,last_used_at from developer_connections where owner_user_id=$1 and service='github'", [owner]))[0]).toEqual({ account_label: 'Replacement', last_used_at: null });
  });
  it('keeps a transient discovery outage from disabling an otherwise active connection', async () => {
    const result = await executeDeveloperResourceTool(db, owner, { provider: 'github' }, { masterKey: () => key, fetchImpl: async () => { throw new Error('synthetic outage'); } });
    expect(result.ok).toBe(false);
    expect((await db.query("select status,last_check_ok from developer_connections where owner_user_id=$1 and service='github'", [owner]))[0]).toEqual({ status: 'active', last_check_ok: false });
  });
});
