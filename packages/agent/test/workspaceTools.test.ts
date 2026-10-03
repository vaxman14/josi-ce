import { beforeEach, describe, expect, it } from 'vitest';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { createThread } from '@josi-ce/core';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { isLocalWorkspaceDiscoveryRequest, runAssistantTurn } from '../src/assistantAgent.js';
import { executeWorkspaceTool, WORKSPACE_TOOLS, workspaceToolNames } from '../src/workspaceTools.js';

let db: TestDb;
let owner: string;
let other: string;

beforeEach(async () => {
  db = await testDb();
  owner = (await createUser(db, {email:'workspace-owner@test.invalid',username:'workspaceowner',role:'member'})).id;
  other = (await createUser(db, {email:'workspace-other@test.invalid',username:'workspaceother',role:'member'})).id;
  await db.query(`insert into storage_capabilities(user_id,may_map_local) values($1,true),($2,true)`,[owner,other]);
  const [root] = await db.query<{id:string}>(`insert into storage_roots(label,container_path,purpose,writable) values('Josi Drive','/data/roots/private-host-path','documents',true) returning id`);
  await db.query(`insert into folder_mappings(owner_user_id,provider,root_id,relative_path,display_path,recursive,may_create,may_edit,may_move,may_delete)
    values($1,'local',$3,'','/workspace',true,true,true,true,true),($2,'local',$3,'secret','Other person',true,false,false,false,false)`,[owner,other,root.id]);
});

describe('workspace mapping discovery', () => {
  it('offers discovery whenever an authorized local mapping exists', async () => {
    expect(await workspaceToolNames(db,owner)).toContain('list_workspace_mappings');
  });

  it('returns only safe display metadata with the canonical mapping_id response key', async () => {
    const result = await executeWorkspaceTool(db,owner,'list_workspace_mappings',{}) as {mappings:Array<Record<string,unknown>>};
    expect(result.mappings).toHaveLength(1);
    expect(result.mappings[0]).toMatchObject({name:'/workspace',recursive:true,permissions:{create:true,edit:true,move:true,delete:true}});
    expect(result.mappings[0].mapping_id).toMatch(/^[a-f0-9-]{36}$/);
    expect(result.mappings[0]).not.toHaveProperty('mappingId');
    expect(JSON.stringify(result)).not.toContain('private-host-path');
    expect(JSON.stringify(result)).not.toContain('Other person');
  });

  it('never discovers another desktop session while retaining server-attached storage', async () => {
    const macSession=(await createSession(db,{userId:owner})).sessionId;
    const windowsSession=(await createSession(db,{userId:owner})).sessionId;
    await db.query(`insert into desktop_workspace_mappings(owner_user_id,client_id,root_id,label,writable,session_id)
      values($1,'desktop_macbook_abcdefghijkl','root_macbook_abcdefghijkl','MacBook MyStuff',false,$2),
            ($1,'desktop_windows_abcdefghijk','root_windows_abcdefghijk','Windows Documents',true,$3)`,
      [owner,macSession,windowsSession]);
    expect(macSession).not.toBe(windowsSession);
    expect(await db.query<{label:string}>(`select label from desktop_workspace_mappings where owner_user_id=$1 and session_id=$2 order by label`,[owner,windowsSession])).toEqual([{label:'Windows Documents'}]);

    const windows=await executeWorkspaceTool(db,owner,'list_workspace_mappings',{}, {desktopSessionId:windowsSession}) as {mappings:Array<{name:string}>};
    expect(windows.mappings.map(mapping=>mapping.name)).toEqual(['/workspace','Windows Documents (this device)']);
    expect(JSON.stringify(windows)).not.toContain('MacBook MyStuff');

    const browser=await executeWorkspaceTool(db,owner,'list_workspace_mappings',{}) as {mappings:Array<{name:string}>};
    expect(browser.mappings.map(mapping=>mapping.name)).toEqual(['/workspace']);
    expect(JSON.stringify(browser)).not.toContain('MacBook MyStuff');
    expect(JSON.stringify(browser)).not.toContain('Windows Documents');
  });

  it('advertises canonical mapping_id requests and does not advertise the compatibility alias', () => {
    const read = WORKSPACE_TOOLS.find(tool => tool.def.name === 'workspace_read')!.def;
    expect(read.parameters.required).toContain('mapping_id');
    expect(read.parameters.properties).toHaveProperty('mapping_id');
    expect(read.parameters.properties).not.toHaveProperty('mappingId');
    expect(read.description).toContain('list_workspace_mappings');
  });

  it('deterministically verifies local-folder questions with a real discovery receipt', async () => {
    const thread = await createThread(db, { ownerUserId: owner });
    const result = await runAssistantTurn({
      db, userId: owner, threadId: thread.id, history: [],
      inbound: 'What local folders can you see?', registry: { db, masterKey: null },
    });
    expect(result.actions).toEqual([{tool:'list_workspace_mappings',result:expect.objectContaining({mappings:expect.any(Array)})}]);
    expect(result.reply).toContain('/workspace (read/write)');
    expect(result.reply).not.toMatch(/no tool result/i);
  });

  it('does not treat a request to connect a folder as a status lookup', () => {
    expect(isLocalWorkspaceDiscoveryRequest('Connect a local folder for me')).toBe(false);
    expect(isLocalWorkspaceDiscoveryRequest('Can you access my local folders?')).toBe(true);
  });
});
