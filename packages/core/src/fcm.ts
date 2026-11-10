import {createSign} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';

/** Android devices register a Firebase token directly, with no Expo in between. It is stored
 * in the same sealed Vault slot as an Expo token, marked so dispatch knows where to send it. */
const STORED=/^fcm:([a-z][a-z0-9-]{4,29}):([A-Za-z0-9_:-]{20,4096})$/;
export function fcmStoredToken(project:string,token:string):string{return `fcm:${project}:${token}`;}
export function fcmTokenParts(stored:string):{project:string;token:string}|null{const m=STORED.exec(stored);return m?{project:m[1],token:m[2]}:null;}
export function isFcmStoredToken(stored:unknown):boolean{return typeof stored==='string'&&STORED.test(stored);}

export interface FcmCredentials{projectId:string;clientEmail:string;privateKey:string;tokenUri:string;}
export const FCM_SERVICE_ACCOUNT_FILENAME='firebase-service-account.json';
/** The file JOSI_FCM_SERVICE_ACCOUNT_FILE names, or firebase-service-account.json beside the
 * master key, which is the installed server's private secrets folder. */
export function fcmCredentialsPath(env:NodeJS.ProcessEnv=process.env):string|null{
  const named=env.JOSI_FCM_SERVICE_ACCOUNT_FILE?.trim();if(named)return named;
  const master=env.MASTER_KEY_FILE?.trim();if(!master)return null;
  const beside=join(dirname(master),FCM_SERVICE_ACCOUNT_FILENAME);return existsSync(beside)?beside:null;
}
/** The server's Firebase service account. Without it Android push stays queued and retries,
 * and nothing else changes. */
export function loadFcmCredentials(env:NodeJS.ProcessEnv=process.env):FcmCredentials|null{
  const file=fcmCredentialsPath(env);if(!file)return null;
  let raw:any;try{raw=JSON.parse(readFileSync(file,'utf8'));}catch{return null;}
  if(raw?.type!=='service_account'||typeof raw.project_id!=='string'||typeof raw.client_email!=='string'||typeof raw.private_key!=='string')return null;
  return{projectId:raw.project_id,clientEmail:raw.client_email,privateKey:raw.private_key,tokenUri:typeof raw.token_uri==='string'?raw.token_uri:'https://oauth2.googleapis.com/token'};
}

export type FcmOutcome=
  |{kind:'accepted'}
  |{kind:'unregistered'}
  |{kind:'failed';code:string}
  |{kind:'retry';code:string;delaySeconds?:number};

const b64url=(value:string|Buffer)=>Buffer.from(value).toString('base64url');
function retryAfter(response:Response):number|undefined{const raw=response.headers.get('retry-after');if(!raw)return;const s=Number(raw);if(Number.isFinite(s))return Math.max(1,Math.min(3600,Math.ceil(s)));const at=Date.parse(raw);return Number.isNaN(at)?undefined:Math.max(1,Math.min(3600,Math.ceil((at-Date.now())/1000)));}
async function bounded(fetchImpl:typeof fetch,url:string,init:RequestInit,timeoutMs=10_000):Promise<Response>{const c=new AbortController();const t=setTimeout(()=>c.abort(),timeoutMs);t.unref?.();try{return await fetchImpl(url,{...init,signal:c.signal});}finally{clearTimeout(t);}}

/** Sends one message through FCM HTTP v1, signing its own short-lived OAuth token. */
export class FcmSender{
  private access:{token:string;expires:number}|null=null;
  constructor(readonly credentials:FcmCredentials,private readonly fetchImpl:typeof fetch,private readonly clock:()=>number=Date.now){}

  private assertion():string{
    const now=Math.floor(this.clock()/1000);
    const head=b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const claims=b64url(JSON.stringify({iss:this.credentials.clientEmail,scope:'https://www.googleapis.com/auth/firebase.messaging',aud:this.credentials.tokenUri,iat:now,exp:now+3600}));
    const signer=createSign('RSA-SHA256');signer.update(`${head}.${claims}`);
    return `${head}.${claims}.${b64url(signer.sign(this.credentials.privateKey))}`;
  }

  async accessToken():Promise<string>{
    if(this.access&&this.access.expires>this.clock()+60_000)return this.access.token;
    const response=await bounded(this.fetchImpl,this.credentials.tokenUri,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:this.assertion()}).toString()});
    if(!response.ok)throw new FcmAuthError(response.status);
    const body=await response.json() as {access_token?:string;expires_in?:number};
    if(typeof body.access_token!=='string')throw new FcmAuthError(response.status);
    this.access={token:body.access_token,expires:this.clock()+Math.max(60,Number(body.expires_in)||3600)*1000};
    return this.access.token;
  }

  /** data values must be strings: FCM rejects anything else. */
  async send(stored:string,data:Record<string,string>):Promise<FcmOutcome>{
    const parts=fcmTokenParts(stored);if(!parts)return{kind:'failed',code:'fcm_invalid_token'};
    if(parts.project!==this.credentials.projectId)return{kind:'failed',code:'MismatchSenderId'};
    let token:string;
    try{token=await this.accessToken();}catch(error){
      if(error instanceof FcmAuthError&&error.status>=400&&error.status<500&&error.status!==408&&error.status!==429)return{kind:'failed',code:`fcm_auth_${error.status}`};
      return{kind:'retry',code:'fcm_auth'};
    }
    let response:Response;
    try{response=await bounded(this.fetchImpl,`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(parts.project)}/messages:send`,{method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},
      body:JSON.stringify({message:{token:parts.token,data,android:{priority:'HIGH',ttl:'86400s'}}})});}
    catch{return{kind:'retry',code:'network'};}
    if(response.ok)return{kind:'accepted'};
    let detail='';try{const body=await response.json() as any;detail=(body?.error?.details??[]).map((d:any)=>d?.errorCode).find((c:unknown)=>typeof c==='string')??body?.error?.status??'';}catch{}
    if(response.status===404||detail==='UNREGISTERED')return{kind:'unregistered'};
    if(response.status===401){this.access=null;return{kind:'retry',code:'fcm_auth'};}
    if(detail==='SENDER_ID_MISMATCH')return{kind:'failed',code:'MismatchSenderId'};
    if(response.status===429||response.status>=500||detail==='QUOTA_EXCEEDED'||detail==='UNAVAILABLE'||detail==='INTERNAL')return{kind:'retry',code:`http_${response.status}`,delaySeconds:retryAfter(response)};
    return{kind:'failed',code:detail?`fcm_${String(detail).toLowerCase()}`:`http_${response.status}`};
  }
}
export class FcmAuthError extends Error{constructor(readonly status:number){super(`Firebase sign-in failed (${status}).`);}}

let shared:{fetchImpl:typeof fetch;sender:FcmSender|null}|null=null;
/** The process-wide sender for the given fetch, or null when the server has no Firebase account. */
export function defaultFcmSender(fetchImpl:typeof fetch):FcmSender|null{
  if(shared?.fetchImpl===fetchImpl)return shared.sender;
  const credentials=loadFcmCredentials();
  shared={fetchImpl,sender:credentials?new FcmSender(credentials,fetchImpl):null};
  return shared.sender;
}
