import { createHash } from 'node:crypto';
import {
  beginDurableToolEffect, completeDurableToolEffect,
  type Db,
} from '@josi-ce/core';

export interface DurableEffectContext {
  turnId?: string | null;
  leaseToken?: string | null;
}

export const MUTATING_TOOLS=new Set([
  'create_task','update_task_slots','approve_task','cancel_task','schedule_reminder','cancel_reminder',
  'draft_email','draft_calendar_event','draft_contact_update','call_custom_api','run_native_workflow',
  'workspace_propose_change','workspace_propose_code','workspace_code_status',
]);

function canonical(value:unknown):string {
  return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))) : item);
}

/** Fence one consequential tool before execution and persist its exact receipt.
 * A crash between those writes leaves `started`; the same effect can then only
 * reconcile as ambiguous, never execute twice. */
export async function runDurableEffect<T>(
  db:Db, ctx:DurableEffectContext, name:string, input:unknown, run:()=>Promise<T>,
):Promise<T> {
  if(!ctx.turnId||!ctx.leaseToken)return run();
  const effectKey=createHash('sha256').update(`${name}\n${canonical(input)}`).digest('hex');
  const reserved=await beginDurableToolEffect(db,{turnId:ctx.turnId,leaseToken:ctx.leaseToken,effectKey,toolName:name});
  if(reserved.state==='completed')return reserved.receipt as T;
  const receipt=await run();
  if(!await completeDurableToolEffect(db,{turnId:ctx.turnId,leaseToken:ctx.leaseToken,effectKey,receipt})){
    throw new Error('durable turn lease was lost before its tool receipt was committed');
  }
  return receipt;
}
