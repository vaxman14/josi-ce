import {createHash,generateKeyPairSync,randomUUID,sign,type KeyObject} from 'node:crypto';
import type {Db} from '@josi-ce/core';
const pairs=new Map<string,{publicKey:KeyObject;privateKey:KeyObject}>();
/** Synthetic executor identity for authenticated HTTP fixtures. No host keys. */
export async function pcExecutorHeaders(db:Db,owner:string,pc:string,method:string,path:string,body?:unknown){
  const id=owner+':'+pc;
  let pair=pairs.get(id);
  if(!pair){pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});pairs.set(id,pair);}
  const jwk=pair.publicKey.export({format:'jwk'});
  const publicKey=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]).toString('base64');
  await db.query('insert into pc_executor_identity(owner_user_id,pc_id,public_key) values($1,$2,$3) on conflict do nothing',[owner,pc,publicKey]);
  const time=Date.now(),nonce=randomUUID(),hash=createHash('sha256').update(body===undefined?'':JSON.stringify(body)).digest('hex');
  const proof=sign('sha256',Buffer.from('pc-executor.1\n'+JSON.stringify([owner,pc,method,path,time,nonce,hash])),pair.privateKey).toString('base64');
  return {'x-josi-pc':pc,'x-josi-pc-time':String(time),'x-josi-pc-nonce':nonce,'x-josi-pc-proof':proof};
}
