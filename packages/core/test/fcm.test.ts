import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,createVerify} from 'node:crypto';
import {testDb,testVault} from './helpers.js';
import {MasterKey} from '../src/masterKey.js';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {FcmSender,fcmStoredToken,fcmTokenParts,loadFcmCredentials,processPushBatch,upsertMobileDevice} from '../src/index.js';

const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const credentials={projectId:'josi-ce',clientEmail:'sender@josi-ce.iam.gserviceaccount.com',privateKey:privateKey.export({type:'pkcs8',format:'pem'}).toString(),tokenUri:'https://oauth2.googleapis.com/token'};
const TOKEN='dGVzdC1mY20tdG9rZW4:APA91bH-example_token-value';
const ok=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

async function setup(platform:'android'|'ios'='android'){
  const db=await testDb();const key=new MasterKey(Buffer.alloc(32,7));await testVault(db,key);
  const [u]=await db.query<{id:string}>(`insert into users(email,username,role) values('fcm@example.test','fcm','member') returning id`);
  const [t]=await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'fcm') returning id`,[u.id]);
  const device=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',platform,expoToken:fcmStoredToken('josi-ce',TOKEN),appState:'background',privacyLocked:false,timezone:'UTC'});
  await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'e1','assistant','turn',$3,'Josi','Your reply is ready.')`,[u.id,device.id,t.id]);
  return{db,key,u,t,device};
}

/** A fake Google: signs in the service account, then answers each FCM send with `reply`. */
function google(reply:()=>Response){
  const calls:{url:string;init:any}[]=[];
  const fetchImpl=(async(url:any,init:any)=>{calls.push({url:String(url),init});
    if(String(url).startsWith('https://oauth2.googleapis.com/token'))return ok({access_token:'access-1',expires_in:3600});
    return reply();}) as typeof fetch;
  return{calls,fetchImpl};
}

describe('Firebase push for Android',()=>{
  it('stores the marked token sealed and refuses it from iOS',async()=>{
    expect(fcmTokenParts(fcmStoredToken('josi-ce',TOKEN))).toEqual({project:'josi-ce',token:TOKEN});
    const {db,device}=await setup();
    const [row]=await db.query<{expo_token_enc:string}>(`select expo_token_enc from mobile_devices where id=$1`,[device.id]);expect(row.expo_token_enc).not.toContain(TOKEN);
    await expect(setup('ios')).rejects.toMatchObject({code:'invalid_expo_token'});
  });

  it('signs in, sends the data shape the app reads, and finishes the delivery',async()=>{
    const {db,key,t}=await setup();const g=google(()=>ok({name:'projects/josi-ce/messages/1'}));
    const result=await processPushBatch(db,key,g.fetchImpl,new Date(),50,new FcmSender(credentials,g.fetchImpl));
    expect(result).toMatchObject({sent:1,accepted:1,ticketed:0,retried:0});
    const [auth,send]=g.calls;
    const assertion=new URLSearchParams(auth.init.body).get('assertion')!;const [h,c,s]=assertion.split('.');
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey,Buffer.from(s,'base64url'))).toBe(true);
    expect(JSON.parse(Buffer.from(c,'base64url').toString())).toMatchObject({iss:credentials.clientEmail,scope:'https://www.googleapis.com/auth/firebase.messaging'});
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/josi-ce/messages:send');
    expect(send.init.headers.Authorization).toBe('Bearer access-1');
    const message=JSON.parse(send.init.body).message;
    expect(message.token).toBe(TOKEN);expect(message.android.priority).toBe('HIGH');
    expect(message.data).toEqual({title:'Josi',message:'Your reply is ready.',body:JSON.stringify({route:'turn',id:t.id})});
    expect(Object.values(message.data).every(v=>typeof v==='string')).toBe(true);
    const [d]=await db.query<{status:string}>(`select status from push_deliveries`);expect(d.status).toBe('provider_accepted');
  });

  it('revokes a device Firebase no longer knows',async()=>{
    const {db,key,device}=await setup();const g=google(()=>ok({error:{status:'NOT_FOUND',details:[{errorCode:'UNREGISTERED'}]}},404));
    await processPushBatch(db,key,g.fetchImpl,new Date(),50,new FcmSender(credentials,g.fetchImpl));
    const [d]=await db.query<{status:string;last_error_code:string}>(`select status,last_error_code from push_deliveries`);expect(d).toEqual({status:'failed',last_error_code:'DeviceNotRegistered'});
    const [m]=await db.query<{revoked_at:string|null}>(`select revoked_at from mobile_devices where id=$1`,[device.id]);expect(m.revoked_at).not.toBeNull();
  });

  it('retries when Firebase is busy and keeps the delivery queued without a sender',async()=>{
    const busy=await setup();const g=google(()=>new Response('{}',{status:503,headers:{'retry-after':'30'}}));
    expect(await processPushBatch(busy.db,busy.key,g.fetchImpl,new Date(),50,new FcmSender(credentials,g.fetchImpl))).toMatchObject({retried:1,accepted:0});
    const [b]=await busy.db.query<{status:string;last_error_code:string}>(`select status,last_error_code from push_deliveries`);expect(b).toEqual({status:'retry',last_error_code:'http_503'});
    const none=await setup();const never=(async()=>{throw new Error('must not call out')}) as typeof fetch;
    expect(await processPushBatch(none.db,none.key,never,new Date(),50,null)).toMatchObject({sent:0,retried:1});
    const [n]=await none.db.query<{status:string;last_error_code:string}>(`select status,last_error_code from push_deliveries`);expect(n).toEqual({status:'retry',last_error_code:'fcm_unconfigured'});
  });

  it('refuses a token from another Firebase project',async()=>{
    const {db,key}=await setup();const g=google(()=>{throw new Error('must not send')});
    await processPushBatch(db,key,g.fetchImpl,new Date(),50,new FcmSender({...credentials,projectId:'someone-else'},g.fetchImpl));
    const [d]=await db.query<{status:string;last_error_code:string}>(`select status,last_error_code from push_deliveries`);expect(d).toEqual({status:'failed',last_error_code:'MismatchSenderId'});
  });

  it('finds the service account beside the master key, or where the setting points',async()=>{
    const dir=mkdtempSync(join(tmpdir(),'josi-fcm-'));const account={type:'service_account',project_id:'josi-ce',client_email:credentials.clientEmail,private_key:credentials.privateKey};
    expect(loadFcmCredentials({MASTER_KEY_FILE:join(dir,'master-key')})).toBeNull();
    writeFileSync(join(dir,'firebase-service-account.json'),JSON.stringify(account));
    expect(loadFcmCredentials({MASTER_KEY_FILE:join(dir,'master-key')})).toMatchObject({projectId:'josi-ce',clientEmail:credentials.clientEmail,tokenUri:'https://oauth2.googleapis.com/token'});
    writeFileSync(join(dir,'other.json'),JSON.stringify({...account,project_id:'other-project'}));
    expect(loadFcmCredentials({MASTER_KEY_FILE:join(dir,'master-key'),JOSI_FCM_SERVICE_ACCOUNT_FILE:join(dir,'other.json')})?.projectId).toBe('other-project');
    writeFileSync(join(dir,'bad.json'),'{"type":"authorized_user"}');expect(loadFcmCredentials({JOSI_FCM_SERVICE_ACCOUNT_FILE:join(dir,'bad.json')})).toBeNull();
    expect(loadFcmCredentials({})).toBeNull();
  });

  it('reuses the access token until it nears expiry',async()=>{
    let now=1_000_000;const g=google(()=>ok({name:'m'}));const sender=new FcmSender(credentials,g.fetchImpl,()=>now);
    await sender.send(fcmStoredToken('josi-ce',TOKEN),{});await sender.send(fcmStoredToken('josi-ce',TOKEN),{});
    expect(g.calls.filter(c=>c.url.includes('oauth2')).length).toBe(1);
    now+=3600_000;await sender.send(fcmStoredToken('josi-ce',TOKEN),{});
    expect(g.calls.filter(c=>c.url.includes('oauth2')).length).toBe(2);
  });
});
