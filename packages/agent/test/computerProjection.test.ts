import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createSession } from '../../auth/src/sessions.js';
import { claimDurableTurn, ComputerControl, createThread, MasterKey, Secret, submitDurableTurn } from '@josi-ce/core';
import { loadStoredProvider, type SpawnRunner } from '@josi-ce/llm';
import { runAssistantTurn } from '../src/assistantAgent.js';

let db:TestDb,userId:string,threadId:string;
const key=new MasterKey(Buffer.alloc(32,41));
beforeEach(async()=>{
  db=await testDb();userId=(await createUser(db,{email:'mac@ce.test',username:'mac',role:'super_admin'})).id;
  await testVault(db,key);threadId=(await createThread(db,{ownerUserId:userId})).id;
  await db.query(`insert into llm_providers(role,provider,model,external_acknowledged,activated_at,probed_at,cap_chat,cap_structured_output,cap_tool_calling,cap_vision,cap_context_tokens)
    values('primary','openai_subscription','test-vision',true,now(),now(),true,true,true,true,8000)`);
});
afterEach(()=>vi.restoreAllMocks());
it.each([false,true])('projects native computer results into exactly one authorized model call; refused=%s',async refused=>{
  const session=await createSession(db,{userId});
  const accepted=await submitDurableTurn(db,{ownerUserId:userId,sessionId:session.sessionId,threadId,clientMessageId:'computer-turn',message:'Read this Mac window.'});
  const turn=(await claimDurableTurn(db,accepted.turn.id))!;
  const requestId=randomUUID(),base64=Buffer.from('disposable-window-fixture').toString('base64');
  const stored=(await loadStoredProvider(db,'primary'))!;
  const beforeDispatch=vi.fn(async()=>{if(refused)throw new Error('saved permission revoked');});
  const finish=vi.fn(async()=>{});
  vi.spyOn(ComputerControl.prototype,'snapshot').mockResolvedValue({devices:[{id:'mac-fixture',revoked:false}],requests:[],proposals:[]} as any);
  const submit=vi.spyOn(ComputerControl.prototype,'submit').mockResolvedValue({id:requestId,state:'succeeded',result:{text:'PRIVATE-WINDOW-FIXTURE',image:{mimeType:'image/jpeg',data:base64}}} as any);
  vi.spyOn(ComputerControl.prototype,'prepareModelProjection').mockImplementation(async(owner,ids)=>{
    expect(owner).toBe(userId);expect(ids).toEqual([requestId]);
    return {expectedPrimary:{providerId:stored.provider,model:stored.model,configurationVersion:stored.updated_at},
      content:()=>new Secret(JSON.stringify({[requestId]:{text:'PRIVATE-WINDOW-FIXTURE',image:{mimeType:'image/jpeg',data:base64}}})),beforeDispatch,finish};
  });
  let calls=0;
  const runner:SpawnRunner=async call=>{
    calls++;
    if(calls===2){
      expect(call.input).toContain('PRIVATE-WINDOW-FIXTURE');
      expect(call.privateFiles?.find(f=>f.name.endsWith('.jpg'))?.base64).toBe(base64);
      await call.beforeStart!();
    }else{
      expect(call.input).not.toContain('PRIVATE-WINDOW-FIXTURE');
      expect(call.privateFiles?.some(f=>f.name.endsWith('.jpg'))).toBe(false);
    }
    const value=calls===1?{reply:'',tool:{name:'computer_operation',arguments:JSON.stringify({device_id:'mac-fixture',idempotency_key:'one',operation:{action:'window.capture',scope:{kind:'application',target:'com.apple.TextEdit|apple|/System/Applications/TextEdit.app'},args:{}}})}}
      :calls===2?{reply:'',tool:{name:'computer_permissions',arguments:'{}'}}:{reply:'The window check finished.',tool:null};
    return {code:0,stderr:'',timedOut:false,stdout:JSON.stringify({type:'agent_message',message:JSON.stringify(value)})};
  };
  const result=await runAssistantTurn({db,userId,threadId,history:[],inbound:'Read this Mac window.',
    inboundMessageId:turn.inbound_message_id,durableTurnId:turn.id,durableLeaseToken:turn.lease_token,
    registry:{db,masterKey:key,codexRunner:runner}});
  expect(submit).toHaveBeenCalledTimes(1);expect(beforeDispatch).toHaveBeenCalledTimes(1);expect(finish).toHaveBeenCalledWith(!refused);
  expect(!!result.refusal).toBe(refused);
  const effects=await db.query('select receipt from assistant_turn_effects where turn_id=$1',[turn.id]);
  expect(JSON.stringify(effects)).not.toContain('PRIVATE-WINDOW-FIXTURE');
  expect(JSON.stringify(result.actions)).not.toContain(base64);
});
