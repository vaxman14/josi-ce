import { createHash, createPublicKey, verify } from 'node:crypto';
import type {Request} from 'express';
import {PcControlError,type Db} from '@josi-ce/core';
const bad=()=>new PcControlError(403,'Approve this PC identity in its native Josi app before running computer control.');
function publicKey(value:string){
  const bytes=Buffer.from(value,'base64');
  if(bytes.length!==65||bytes[0]!==4)throw bad();
  return createPublicKey({key:{kty:'EC',crv:'P-256',x:bytes.subarray(1,33).toString('base64url'),y:bytes.subarray(33).toString('base64url')},format:'jwk'});
}
export async function verifyPcExecutor(db:Db,req:Request,pcId:string,enrollmentKey?:string){
  const owner=req.user!.id, timestamp=Number(req.get('x-josi-pc-time')),nonce=req.get('x-josi-pc-nonce')??'';
  if(!Number.isSafeInteger(timestamp)||Math.abs(Date.now()-timestamp)>30000||!/^[0-9a-f-]{36}$/.test(nonce))throw bad();
  const [stored]=await db.query<{public_key:string}>('select public_key from pc_executor_identity where owner_user_id=$1 and pc_id=$2',[owner,pcId]);
  if(enrollmentKey&&stored&&stored.public_key!==enrollmentKey)throw new PcControlError(409,'This PC already has a different approved key. Revoke its old identity first.');
  const key=enrollmentKey??stored?.public_key;if(!key)throw bad();
  const body=createHash('sha256').update(req.rawBody??Buffer.alloc(0)).digest('hex');
  const message='pc-executor.1\n'+JSON.stringify([owner,pcId,req.method,req.originalUrl,timestamp,nonce,body]);
  if(!verify('sha256',Buffer.from(message),publicKey(key),Buffer.from(req.get('x-josi-pc-proof')??'','base64')))throw bad();
  const used=await db.query('insert into pc_executor_nonce(owner_user_id,pc_id,nonce,expires_at) values($1,$2,$3,now()+interval \'60 seconds\') on conflict do nothing returning nonce',[owner,pcId,nonce]);
  if(!used.length)throw bad();
  await db.query('delete from pc_executor_nonce where expires_at<now()');
}
