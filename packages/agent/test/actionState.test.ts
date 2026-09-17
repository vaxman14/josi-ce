import {beforeEach,describe,expect,it} from 'vitest';
import {testDb,type TestDb} from '../../core/test/helpers.js';
import {createUser} from '../../auth/src/users.js';
import {addMessage,createThread,getTask,markActionsPresented,MasterKey} from '@josi-ce/core';
import {setCapability,upsertConnection} from '@josi-ce/connectors';
import {executeAssistantTool} from '../src/execute.js';

let db:TestDb;
let user:string;
let thread:string;
const key=new MasterKey(Buffer.alloc(32,8));

beforeEach(async()=>{
  db=await testDb();
  user=(await createUser(db,{email:'state@example.test',username:'state',role:'super_admin'})).id;
  thread=(await createThread(db,{ownerUserId:user})).id;
});

const ctx=()=>({userId:user,threadId:thread,turnId:null,connectors:{masterKey:()=>key}});
async function present(result:{task_id?:unknown},body:string){
  const message=await addMessage(db,{threadId:thread,direction:'out',body});
  if(typeof result.task_id==='string')await markActionsPresented(db,{ownerUserId:user,threadId:thread,taskIds:[result.task_id],messageId:message.id});
}

describe('action drafts are merged only inside their namespace',()=>{
  it('completes the exact email transcript while preserving recipient and body',async()=>{
    const first=await executeAssistantTool(db,ctx(),'draft_email',{
      recipient:'romanvaxman14@gmail.com',body:'testing the connection',
    }) as any;
    expect(first).toMatchObject({ok:true,state:'collecting',missing_slots:['subject']});
    await present(first,'What subject should I use?');

    const second=await executeAssistantTool(db,ctx(),'draft_email',{
      subject:'testing the coonection',
    }) as any;
    expect(second.state).toBe('prepared');
    expect(second.summary).toBe('Send email\nTo: romanvaxman14@gmail.com\nSubject: testing the coonection\nBody: testing the connection');
    const task=await getTask(db,second.task_id);
    expect(task.slots).toMatchObject({recipient:'romanvaxman14@gmail.com',subject:'testing the coonection',body:'testing the connection'});
    expect(await db.query(`select id from approvals where subject_type='task' and subject_id=$1 and status='pending'`,[task.id])).toHaveLength(1);
  });

  it('resolves “the main one” only from unambiguous provider primary metadata',async()=>{
    const connection=await upsertConnection(db,key,{ownerUserId:user,provider:'google',providerAccountId:'acct',accountEmail:'state@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar'},
      requestedCapabilities:['google.calendar.read','google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:user});
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable)
      values($1,$2,'primary','Main calendar',true,true),($1,$2,'other','LexisNexis archive',false,true)`,[user,connection.id]);

    const first=await executeAssistantTool(db,ctx(),'draft_calendar_event',{
      title:'Phone call with EDD',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00',
    }) as any;
    expect(first).toMatchObject({ok:false,error:'select_calendar',state:'collecting'});
    await present(first,'Which calendar should I use?');

    const second=await executeAssistantTool(db,ctx(),'draft_calendar_event',{calendar:'the main one'}) as any;
    expect(second.state).toBe('prepared');
    expect(second.summary).toContain('Calendar: Main calendar');
    expect(second.summary).toContain('Title: Phone call with EDD');
    expect(second.summary).not.toContain('LexisNexis');
    const task=await getTask(db,second.task_id);
    expect(task.slots).not.toHaveProperty('event_id');
    expect(task.slots.calendar_source).toMatchObject({calendar_id:'primary',calendar_name:'Main calendar'});
  });

  it('does not guess when primary metadata is ambiguous',async()=>{
    const connection=await upsertConnection(db,key,{ownerUserId:user,provider:'google',providerAccountId:'acct2',accountEmail:'state@example.test',
      tokens:{accessToken:'access',refreshToken:'refresh',expiresIn:3600,grantedScopes:'https://www.googleapis.com/auth/calendar'},requestedCapabilities:['google.calendar.write']});
    await setCapability(db,{connection,capability:'google.calendar.write',enabled:true,actorUserId:user});
    await db.query(`insert into calendar_sources(owner_user_id,connection_id,provider_calendar_id,name,is_primary,writable)
      values($1,$2,'one','One',true,true),($1,$2,'two','Two',true,true)`,[user,connection.id]);
    const first=await executeAssistantTool(db,ctx(),'draft_calendar_event',{title:'Phone call with EDD',start:'2026-09-18T15:00:00-07:00',end:'2026-09-18T15:30:00-07:00'}) as any;
    await present(first,'Which calendar should I use?');
    const result=await executeAssistantTool(db,ctx(),'draft_calendar_event',{calendar:'the main one'}) as any;
    expect(result).toMatchObject({ok:false,error:'select_calendar'});
  });
});
