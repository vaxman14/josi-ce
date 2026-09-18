import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { createThread } from '@josi-ce/core';
import { runAssistantTurn } from '../src/assistantAgent.js';
import type { SpawnRunner } from '@josi-ce/llm';

let db:TestDb;let userId:string;let threadId:string;let oldServer:string|undefined;
const privateReceipt='123e4567-e89b-42d3-a456-426614174000';

function contextPath(args:string[]):string{
  const override=args.find(value=>value.includes('JOSI_MCP_CONTEXT'))!;
  return JSON.parse(override.slice(override.indexOf('"'),override.lastIndexOf('"')+1));
}

beforeEach(async()=>{
  db=await testDb();
  userId=(await createUser(db,{email:'subscription-turn@ce.test',username:'subscription-turn',role:'super_admin'})).id;
  threadId=(await createThread(db,{ownerUserId:userId})).id;
  await db.query(`insert into llm_providers(role,provider,model,external_acknowledged,activated_at,probed_at,cap_chat,cap_structured_output,cap_tool_calling,cap_context_tokens) values('primary','openai_subscription','',true,now(),now(),true,false,true,8000)`);
  const dir=mkdtempSync(join(tmpdir(),'josi-subscription-turn-'));
  const server=join(dir,'server.js');writeFileSync(server,'// test seam');
  oldServer=process.env.JOSI_MCP_SERVER;process.env.JOSI_MCP_SERVER=server;
});
afterEach(()=>{if(oldServer===undefined)delete process.env.JOSI_MCP_SERVER;else process.env.JOSI_MCP_SERVER=oldServer;});

describe('subscription turn receipts',()=>{
  it('propagates the private real-result handoff through grounding and presentation without exposing it',async()=>{
    const runner:SpawnRunner=async({args})=>{
      const ctx=JSON.parse(readFileSync(contextPath(args),'utf8'));
      expect(ctx.tools).toContain('get_provider_status');
      const result={ok:true,providers:[{name:'Google Calendar',state:'connected'}],receipt:privateReceipt,observed_at:'2026-09-18T04:05:00Z'};
      writeFileSync(ctx.callsPath,`${JSON.stringify({id:'status-1',name:'get_provider_status',input:{},result})}\n`,{mode:0o600});
      return {code:0,timedOut:false,stderr:'',stdout:JSON.stringify({type:'agent_message',message:`Google Calendar is connected. Receipt ID: ${privateReceipt}`})};
    };
    const result=await runAssistantTurn({db,userId,threadId,history:[],inbound:'Is my calendar connected?',registry:{db,masterKey:null,codexRunner:runner}});
    expect(result.actions).toEqual([{tool:'get_provider_status',result:expect.objectContaining({ok:true,providers:[{name:'Google Calendar',state:'connected'}]})}]);
    expect(result.reply).toContain('Google Calendar is connected');
    expect(result.reply).not.toContain(privateReceipt);
    expect(result.reply).not.toMatch(/receipt id/i);
  });
});
