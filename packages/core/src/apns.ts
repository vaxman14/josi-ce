import {createPrivateKey,createSign,type KeyObject} from 'node:crypto';
import {connect,type ClientHttp2Session} from 'node:http2';
import type {Db} from './db.js';
import type {MasterKey} from './masterKey.js';
import {asSecret} from './sealing.js';
import {deleteVaultSlot,openCredentialPayload,storeVaultCredentialPayload} from './vault.js';

/** iPhones register their Apple push address directly, with nothing in between. It is stored in
 * the same sealed Vault slot as any other push token, marked so dispatch knows where to send it:
 * the environment the build talks to, the app it belongs to, and the device token. */
const STORED=/^apns:(sandbox|production):([A-Za-z0-9][A-Za-z0-9.-]{2,154}):([0-9a-f]{64,200})$/;
export type ApnsEnvironment='sandbox'|'production';
export const DEFAULT_APPLE_BUNDLE_ID='com.socalreceptionist.josice';
export const DEFAULT_APPLE_TEAM_ID='LRH75YR6QW';
export function apnsStoredToken(environment:string,topic:string,token:string):string{return `apns:${environment}:${topic}:${token.toLowerCase()}`;}
export function apnsTokenParts(stored:string):{environment:ApnsEnvironment;topic:string;token:string}|null{
  const m=STORED.exec(stored);return m?{environment:m[1] as ApnsEnvironment,topic:m[2],token:m[3]}:null;
}
export function isApnsStoredToken(stored:unknown):boolean{return typeof stored==='string'&&STORED.test(stored);}

export interface ApnsCredentials{keyId:string;teamId:string;privateKey:string;}
export type ApnsOutcome=
  |{kind:'accepted'}
  |{kind:'unregistered'}
  |{kind:'failed';code:string}
  |{kind:'retry';code:string;delaySeconds?:number};
export interface ApnsMessage{title:string;body:string;data:Record<string,unknown>;threadId?:string;}
export interface ApnsRequest{host:string;path:string;headers:Record<string,string>;body:string;}
export interface ApnsResponse{status:number;body:string;retryAfter?:string;}
/** Apple only speaks HTTP/2, which `fetch` does not promise. Injected so tests never contact Apple. */
export type ApnsTransport=(request:ApnsRequest)=>Promise<ApnsResponse>;

export class ApnsKeyError extends Error{constructor(readonly code:string,message:string){super(message);}}
const KEY_ID=/^[A-Z0-9]{10}$/;
/** Accepts the .p8 as Apple hands it out, however the line endings arrived. */
export function normalizeApplePrivateKey(raw:string):string{
  const text=String(raw??'').replace(/\r\n?/g,'\n').trim();
  return text?`${text}\n`:'';
}
export function parseApplePrivateKey(raw:string):KeyObject{
  const pem=normalizeApplePrivateKey(raw);
  if(!pem.includes('BEGIN PRIVATE KEY'))throw new ApnsKeyError('invalid_key','Paste the whole .p8 file, including the BEGIN and END lines.');
  let key:KeyObject;try{key=createPrivateKey(pem);}catch{throw new ApnsKeyError('invalid_key','That is not a readable .p8 key.');}
  if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')throw new ApnsKeyError('invalid_key','That key is not an Apple .p8 key.');
  return key;
}
export function validateApnsCredentials(input:{keyId:unknown;teamId:unknown;privateKey:unknown}):ApnsCredentials{
  const keyId=String(input.keyId??'').trim().toUpperCase(),teamId=String(input.teamId??'').trim().toUpperCase();
  if(!KEY_ID.test(keyId))throw new ApnsKeyError('invalid_key_id','The Key ID is 10 letters and digits, shown next to the key in the Apple Developer portal.');
  if(!KEY_ID.test(teamId))throw new ApnsKeyError('invalid_team_id','The Team ID is 10 letters and digits, shown under Membership in the Apple Developer portal.');
  const privateKey=normalizeApplePrivateKey(String(input.privateKey??''));parseApplePrivateKey(privateKey);
  return{keyId,teamId,privateKey};
}

const b64url=(value:string|Buffer)=>Buffer.from(value).toString('base64url');
const HOSTS:Record<ApnsEnvironment,string>={production:'api.push.apple.com',sandbox:'api.sandbox.push.apple.com'};
/** Apple refuses a provider token older than an hour and punishes one refreshed more often than
 * every twenty minutes, so one token is kept for fifty. */
const TOKEN_LIFE_MS=50*60_000;

/** Sends one notification to Apple with token authentication (a .p8 key, its Key ID, the Team ID). */
export class ApnsSender{
  private token:{value:string;minted:number}|null=null;
  private readonly key:KeyObject;
  constructor(readonly credentials:ApnsCredentials,private readonly transport:ApnsTransport=http2Transport,private readonly clock:()=>number=Date.now){
    this.key=parseApplePrivateKey(credentials.privateKey);
  }
  providerToken():string{
    const now=this.clock();
    if(this.token&&now-this.token.minted<TOKEN_LIFE_MS)return this.token.value;
    const head=b64url(JSON.stringify({alg:'ES256',kid:this.credentials.keyId}));
    const claims=b64url(JSON.stringify({iss:this.credentials.teamId,iat:Math.floor(now/1000)}));
    const signer=createSign('SHA256');signer.update(`${head}.${claims}`);
    const value=`${head}.${claims}.${b64url(signer.sign({key:this.key,dsaEncoding:'ieee-p1363'}))}`;
    this.token={value,minted:now};return value;
  }
  async send(stored:string,message:ApnsMessage):Promise<ApnsOutcome>{
    const parts=apnsTokenParts(stored);if(!parts)return{kind:'failed',code:'apns_invalid_token'};
    // What the person sees lives in `aps`; the app's own routing data sits beside it.
    const payload={aps:{alert:{title:message.title,body:message.body},sound:'default',...(message.threadId?{'thread-id':message.threadId}:{})},data:message.data};
    let response:ApnsResponse;
    try{response=await this.transport({host:HOSTS[parts.environment],path:`/3/device/${parts.token}`,body:JSON.stringify(payload),headers:{
      authorization:`bearer ${this.providerToken()}`,'apns-topic':parts.topic,'apns-push-type':'alert','apns-priority':'10',
      'apns-expiration':String(Math.floor(this.clock()/1000)+86_400),'content-type':'application/json'}});}
    catch{return{kind:'retry',code:'network'};}
    if(response.status===200)return{kind:'accepted'};
    let reason='';try{reason=String((JSON.parse(response.body) as {reason?:unknown})?.reason??'');}catch{}
    if(response.status===410||reason==='Unregistered'||reason==='BadDeviceToken')return{kind:'unregistered'};
    if(reason==='ExpiredProviderToken'){this.token=null;return{kind:'retry',code:'apns_auth'};}
    if(reason==='TooManyProviderTokenUpdates')return{kind:'retry',code:'apns_auth',delaySeconds:1200};
    if(response.status===403)return{kind:'failed',code:reason==='InvalidProviderToken'?'apns_invalid_key':`apns_${reason||'forbidden'}`};
    if(response.status===429||response.status>=500){const s=Number(response.retryAfter);return{kind:'retry',code:`http_${response.status}`,delaySeconds:Number.isFinite(s)&&s>0?Math.min(3600,Math.ceil(s)):undefined};}
    return{kind:'failed',code:reason?`apns_${reason}`:`http_${response.status}`};
  }
  /** Asks Apple whether it accepts this key, without a real phone: a made-up device is refused
   * as a bad device when the key is good, and as a bad key when it is not. */
  async check(topic=DEFAULT_APPLE_BUNDLE_ID):Promise<'accepted'|'rejected'|'unknown'>{
    const outcome=await this.send(apnsStoredToken('production',topic,'0'.repeat(64)),{title:'Josi',body:'Key check',data:{}});
    if(outcome.kind==='unregistered'||outcome.kind==='accepted')return'accepted';
    if(outcome.kind==='failed'&&(outcome.code==='apns_invalid_key'||outcome.code==='apns_forbidden'||outcome.code==='apns_InvalidProviderToken'))return'rejected';
    return'unknown';
  }
}

const sessions=new Map<string,ClientHttp2Session>();
function session(host:string):ClientHttp2Session{
  const open=sessions.get(host);if(open&&!open.closed&&!open.destroyed)return open;
  const next=connect(`https://${host}`);next.unref();
  const drop=()=>{if(sessions.get(host)===next)sessions.delete(host);};
  next.on('error',drop);next.on('close',drop);next.on('goaway',drop);
  // Apple closes idle connections; let go first so a send never rides a dead one.
  next.setTimeout(5*60_000,()=>{drop();next.close();});
  sessions.set(host,next);return next;
}
export const http2Transport:ApnsTransport=request=>new Promise((resolve,reject)=>{
  let stream;try{stream=session(request.host).request({':method':'POST',':path':request.path,...request.headers});}catch(error){sessions.delete(request.host);reject(error);return;}
  let status=0,retryAfter:string|undefined;const chunks:Buffer[]=[];
  stream.setTimeout(10_000,()=>{stream.close();reject(new Error('timeout'));});
  stream.on('response',headers=>{status=Number(headers[':status']);const r=headers['retry-after'];if(typeof r==='string')retryAfter=r;});
  stream.on('data',chunk=>chunks.push(Buffer.from(chunk)));
  stream.on('end',()=>resolve({status,body:Buffer.concat(chunks).toString('utf8'),retryAfter}));
  stream.on('error',error=>{sessions.delete(request.host);reject(error);});
  stream.end(request.body);
});

// ---------------------------------------------------------------- the server's own key
const SERVICE='server.push',SLOT='apple';
export interface ApplePushKeyStatus{configured:boolean;keyId:string|null;teamId:string|null;checked:string|null;updatedAt:string|null;}
export async function applePushKeyStatus(db:Db):Promise<ApplePushKeyStatus>{
  const [row]=await db.query<{key_id:string;team_id:string;checked:string;updated_at:string}>(`select key_id,team_id,checked,updated_at from server_push_keys where provider='apple'`);
  return row?{configured:true,keyId:row.key_id,teamId:row.team_id,checked:row.checked,updatedAt:new Date(row.updated_at).toISOString()}
    :{configured:false,keyId:null,teamId:null,checked:null,updatedAt:null};
}
/** Seals the key in the Vault under the admin who pasted it. Only its ids are kept in the open. */
export async function saveApplePushKey(db:Db,key:MasterKey,args:{actorUserId:string;credentials:ApnsCredentials;checked:'accepted'|'unknown'}):Promise<void>{
  if(!db.transaction)throw new Error('saving the Apple push key requires transaction support');
  await db.transaction(async tx=>{
    const [old]=await tx.query<{owner_user_id:string}>(`select owner_user_id from server_push_keys where provider='apple' for update`);
    if(old&&old.owner_user_id!==args.actorUserId)await deleteVaultSlot(tx,{ownerUserId:old.owner_user_id,service:SERVICE,slot:SLOT,actorUserId:args.actorUserId});
    const stored=await storeVaultCredentialPayload(tx,key,{ownerUserId:args.actorUserId,kind:'api_key',service:SERVICE,slot:SLOT,
      label:'Apple push key',payload:{privateKey:asSecret(args.credentials.privateKey)}});
    await tx.query(`insert into server_push_keys(provider,owner_user_id,key_id,team_id,credential_enc,checked) values('apple',$1,$2,$3,$4,$5)
      on conflict(provider) do update set owner_user_id=excluded.owner_user_id,key_id=excluded.key_id,team_id=excluded.team_id,credential_enc=excluded.credential_enc,checked=excluded.checked,updated_at=now()`,
      [args.actorUserId,args.credentials.keyId,args.credentials.teamId,stored,args.checked]);
  });
  cached=null;
}
export async function deleteApplePushKey(db:Db,actorUserId:string):Promise<boolean>{
  if(!db.transaction)throw new Error('removing the Apple push key requires transaction support');
  const removed=await db.transaction(async tx=>{
    const rows=await tx.query<{owner_user_id:string}>(`delete from server_push_keys where provider='apple' returning owner_user_id`);
    if(rows[0])await deleteVaultSlot(tx,{ownerUserId:rows[0].owner_user_id,service:SERVICE,slot:SLOT,actorUserId});
    return !!rows.length;
  });
  cached=null;return removed;
}
let cached:{stamp:string;transport:ApnsTransport;sender:ApnsSender}|null=null;
/** The process-wide sender for the saved key, or null when this server has none. A replaced key
 * is picked up on the next batch: the stamp changes with every save. */
export async function defaultApnsSender(db:Db,key:MasterKey,transport:ApnsTransport=http2Transport):Promise<ApnsSender|null>{
  const [row]=await db.query<{owner_user_id:string;key_id:string;team_id:string;credential_enc:string;updated_at:string}>(`select owner_user_id,key_id,team_id,credential_enc,updated_at from server_push_keys where provider='apple'`);
  if(!row){cached=null;return null;}
  const stamp=`${row.key_id}:${new Date(row.updated_at).getTime()}`;
  if(cached?.stamp===stamp&&cached.transport===transport)return cached.sender;
  const payload=await openCredentialPayload<{privateKey?:string}>(db,key,{ownerUserId:row.owner_user_id,service:SERVICE,slot:SLOT,stored:row.credential_enc});
  if(typeof payload.privateKey!=='string')return null;
  let sender:ApnsSender;try{sender=new ApnsSender({keyId:row.key_id,teamId:row.team_id,privateKey:payload.privateKey},transport);}catch{return null;}
  cached={stamp,transport,sender};return sender;
}
