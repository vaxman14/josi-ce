import {createHash,createPublicKey,randomUUID} from 'node:crypto';
import {generateAuthenticationOptions,verifyAuthenticationResponse,type AuthenticationResponseJSON} from '@simplewebauthn/server';
import {isoCBOR} from '@simplewebauthn/server/helpers';
import type {Db} from '@josi-ce/core';
import type {RelyingParty} from './passkeys.js';
import {WebAuthnError} from './webauthn.js';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export async function beginPcPasskey(db:Db,rp:RelyingParty,owner:string,proposalId:string,proposalDigest:string){
  const keys=await db.query<{credential_id:string;transports:string[]}>('select credential_id,transports from auth_passkeys where user_id=$1',[owner]);
  if(!keys.length)throw new WebAuthnError('Add a passkey to this account, or approve with your account password.');
  const options=await generateAuthenticationOptions({rpID:rp.id,userVerification:'required',timeout:120000,allowCredentials:keys.map(k=>({id:k.credential_id,transports:k.transports}))});
  const id=randomUUID();
  await db.query('delete from pc_passkey_approvals where expires_at<now()');
  const [pending]=await db.query<{count:number}>('select count(*)::int as count from pc_passkey_approvals where owner_user_id=$1 and used_at is null',[owner]);
  if((pending?.count??0)>=30)throw new WebAuthnError('Wait before requesting another passkey approval.');
  await db.query('insert into pc_passkey_approvals(id,owner_user_id,proposal_id,proposal_digest,challenge_hash,expires_at) values($1,$2,$3,$4,$5,now()+interval \'2 minutes\')',[id,owner,proposalId,proposalDigest,digest(options.challenge)]);
  return {id,options};
}
/** Convert the existing SPKI public keys to COSE for the maintained verifier.
 * This preserves existing credentials and does not register replacement keys. */
function cose(spki:string,algorithm:number){
  const key=createPublicKey({key:Buffer.from(spki,'base64'),format:'der',type:'spki'}).export({format:'jwk'});
  const bytes=(value:string|undefined)=>new Uint8Array(Buffer.from(value??'','base64url'));
  const map=new Map<number,number|Uint8Array>();map.set(3,algorithm);
  if(key.kty==='EC'&&key.crv==='P-256'&&algorithm===-7){map.set(1,2);map.set(-1,1);map.set(-2,bytes(key.x));map.set(-3,bytes(key.y));}
  else if(key.kty==='OKP'&&key.crv==='Ed25519'&&algorithm===-8){map.set(1,1);map.set(-1,6);map.set(-2,bytes(key.x));}
  else if(key.kty==='RSA'&&algorithm===-257){map.set(1,3);map.set(-1,bytes(key.n));map.set(-2,bytes(key.e));}
  else throw new WebAuthnError('This passkey algorithm is unavailable.');
  return isoCBOR.encode(map);
}
export async function finishPcPasskey(db:Db,rp:RelyingParty,owner:string,proposalId:string,proposalDigest:string,id:string,response:AuthenticationResponseJSON){
  if(!/^[a-f0-9-]{36}$/i.test(id)||typeof response?.id!=='string')throw new WebAuthnError('Invalid passkey approval.');
  if(!db.transaction)throw new WebAuthnError('Transactional approval storage is unavailable.');
  await db.transaction(async tx=>{
    const [challenge]=await tx.query<{challenge_hash:string}>('update pc_passkey_approvals set used_at=now() where id=$1 and owner_user_id=$2 and proposal_id=$3 and proposal_digest=$4 and used_at is null and expires_at>now() returning challenge_hash',[id,owner,proposalId,proposalDigest]);
    if(!challenge)throw new WebAuthnError('This approval expired or the permission changed. Review it again.');
    const [key]=await tx.query<{id:string;public_key:string;algorithm:number;sign_count:string}>('select id,public_key,algorithm,sign_count from auth_passkeys where user_id=$1 and credential_id=$2 for update',[owner,response.id]);
    if(!key)throw new WebAuthnError('Use a passkey belonging to the signed-in account.');
    const result=await verifyAuthenticationResponse({response,expectedOrigin:rp.origin,expectedRPID:rp.id,expectedChallenge:value=>digest(value)===challenge.challenge_hash,requireUserVerification:true,
      credential:{id:response.id,publicKey:cose(key.public_key,key.algorithm),counter:Number(key.sign_count)}});
    if(!result.verified)throw new WebAuthnError('The passkey did not verify this approval.');
    await tx.query('update auth_passkeys set sign_count=$2,last_used_at=now() where id=$1',[key.id,result.authenticationInfo.newCounter]);
  });
}
