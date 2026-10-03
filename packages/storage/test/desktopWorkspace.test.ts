import {beforeAll,describe,expect,it} from 'vitest';
import {testDb,type TestDb} from '../../core/test/helpers.js';
import {createUser} from '../../auth/src/users.js';
import {createSession} from '../../auth/src/sessions.js';
import {activeDesktopWorkspaceMappings,requestDesktopWorkspace} from '../src/desktopWorkspace.js';

let db:TestDb,user:string,other:string,mapping:string,session:string,otherSession:string;
beforeAll(async()=>{db=await testDb();user=(await createUser(db,{email:'desktop@example.test',username:'desktop',role:'member'})).id;other=(await createUser(db,{email:'other-desktop@example.test',username:'other-desktop',role:'member'})).id;
 session=(await createSession(db,{userId:user})).sessionId;otherSession=(await createSession(db,{userId:user})).sessionId;
 const [m]=await db.query<{id:string}>(`insert into desktop_workspace_mappings(owner_user_id,client_id,root_id,label,writable,session_id) values($1,'desktop_abcdefghijklmnop','root_abcdefghijklmnop','Documents',true,$2) returning id`,[user,session]);mapping=m.id;
});

describe('desktop workspace relay',()=>{
 it('discovers only the active mapping from this exact desktop session',async()=>{expect((await activeDesktopWorkspaceMappings(db,user,session)).map(m=>m.id)).toEqual([mapping]);expect(await activeDesktopWorkspaceMappings(db,user,otherSession)).toEqual([]);expect(await activeDesktopWorkspaceMappings(db,user,null)).toEqual([]);expect(await activeDesktopWorkspaceMappings(db,other,session)).toEqual([]);});
 it('round-trips one bounded request and result',async()=>{
  const pending=requestDesktopWorkspace(db,user,session,mapping,'read',{path:'notes/today.txt'});
  let request:{id:string}|undefined;for(let i=0;i<20&&!request;i++){[request]=await db.query<{id:string}>(`select id from desktop_workspace_requests where mapping_id=$1`,[mapping]);if(!request)await new Promise(resolve=>setTimeout(resolve,10));}
  expect(request).toBeTruthy();await db.query(`update desktop_workspace_requests set status='completed',response=$2,completed_at=now() where id=$1`,[request!.id,JSON.stringify({text:'hello',size:5})]);
  await expect(pending).resolves.toEqual({text:'hello',size:5});
 });
 it('blocks traversal, another owner, and another device session',async()=>{await expect(requestDesktopWorkspace(db,user,session,mapping,'read',{path:'../secret'})).rejects.toThrow();await expect(requestDesktopWorkspace(db,other,session,mapping,'read',{path:'ok.txt'})).rejects.toThrow();await expect(requestDesktopWorkspace(db,user,otherSession,mapping,'read',{path:'ok.txt'})).rejects.toThrow();});
});
