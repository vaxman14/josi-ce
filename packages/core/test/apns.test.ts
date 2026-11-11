import {describe,it,expect} from 'vitest';
import {generateKeyPairSync,createVerify} from 'node:crypto';
import {testDb,testVault} from './helpers.js';
import {MasterKey} from '../src/masterKey.js';
import {ApnsSender,apnsStoredToken,apnsTokenParts,applePushKeyStatus,defaultApnsSender,deleteApplePushKey,processPushBatch,saveApplePushKey,upsertMobileDevice,validateApnsCredentials,type ApnsRequest,type ApnsTransport} from '../src/index.js';

const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const P8=privateKey.export({type:'pkcs8',format:'pem'}).toString();
const credentials={keyId:'ABC123DEFG',teamId:'LRH75YR6QW',privateKey:P8};
const TOKEN='a1'.repeat(32);
const TOPIC='com.socalreceptionist.josice';

function apple(reply:(request:ApnsRequest)=>{status:number;body?:string}){
  const calls:ApnsRequest[]=[];
  const transport:ApnsTransport=async request=>{calls.push(request);const r=reply(request);return{status:r.status,body:r.body??''};};
  return{calls,transport};
}
async function setup(environment:'sandbox'|'production'='production'){
  const db=await testDb();const key=new MasterKey(Buffer.alloc(32,7));await testVault(db,key);
  const [u]=await db.query<{id:string}>(`insert into users(email,username,role) values('apns@example.test','apns','member') returning id`);
  const [t]=await db.query<{id:string}>(`insert into threads(owner_user_id,title) values($1,'apns') returning id`,[u.id]);
  const device=await upsertMobileDevice(db,key,u.id,{deviceIdentity:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',platform:'ios',expoToken:apnsStoredToken(environment,TOPIC,TOKEN),appState:'background',privacyLocked:false,timezone:'UTC'});
  await db.query(`insert into push_deliveries(owner_user_id,device_id,event_key,category,route_type,route_id,title,body) values($1,$2,'e1','assistant','turn',$3,'Josi','Your reply is ready.')`,[u.id,device.id,t.id]);
  return{db,key,u,t,device};
}

describe('Apple push for iPhone',()=>{
  it('stores the marked address sealed, and only for an iPhone',async()=>{
    expect(apnsTokenParts(apnsStoredToken('sandbox',TOPIC,TOKEN.toUpperCase()))).toEqual({environment:'sandbox',topic:TOPIC,token:TOKEN});
    expect(apnsTokenParts('apns:production:x:zz')).toBeNull();
    const {db,key,u,device}=await setup();
    const [row]=await db.query<{expo_token_enc:string}>(`select expo_token_enc from mobile_devices where id=$1`,[device.id]);expect(row.expo_token_enc).not.toContain(TOKEN);
    await expect(upsertMobileDevice(db,key,u.id,{deviceIdentity:'dddddddd-dddd-4ddd-8ddd-dddddddddddd',platform:'android',expoToken:apnsStoredToken('production',TOPIC,TOKEN),appState:'background',privacyLocked:false,timezone:'UTC'})).rejects.toMatchObject({code:'invalid_expo_token'});
  });

  it('signs a token Apple can verify and sends what the person sees beside the app data',async()=>{
    const {calls,transport}=apple(()=>({status:200}));
    const sender=new ApnsSender(credentials,transport,()=>1_800_000_000_000);
    expect(await sender.send(apnsStoredToken('sandbox',TOPIC,TOKEN),{title:'Josi',body:'Hello',data:{route:'turn',id:'t1'},threadId:'th1'})).toEqual({kind:'accepted'});
    const call=calls[0];expect(call.host).toBe('api.sandbox.push.apple.com');expect(call.path).toBe(`/3/device/${TOKEN}`);
    expect(call.headers['apns-topic']).toBe(TOPIC);expect(call.headers['apns-push-type']).toBe('alert');
    expect(JSON.parse(call.body)).toEqual({aps:{alert:{title:'Josi',body:'Hello'},sound:'default','thread-id':'th1'},data:{route:'turn',id:'t1'}});
    const [head,claims,signature]=call.headers.authorization.replace('bearer ','').split('.');
    expect(JSON.parse(Buffer.from(head,'base64url').toString())).toEqual({alg:'ES256',kid:'ABC123DEFG'});
    expect(JSON.parse(Buffer.from(claims,'base64url').toString())).toEqual({iss:'LRH75YR6QW',iat:1_800_000_000});
    const verify=createVerify('SHA256');verify.update(`${head}.${claims}`);
    expect(verify.verify({key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url'))).toBe(true);
    await sender.send(apnsStoredToken('production',TOPIC,TOKEN),{title:'Josi',body:'Again',data:{}});
    expect(calls[1].host).toBe('api.push.apple.com');expect(calls[1].headers.authorization).toBe(call.headers.authorization);
  });

  it('reads Apple\'s answers: gone, bad key, busy',async()=>{
    const answer=async(status:number,reason?:string)=>new ApnsSender(credentials,apple(()=>({status,body:reason?JSON.stringify({reason}):''})).transport)
      .send(apnsStoredToken('production',TOPIC,TOKEN),{title:'Josi',body:'x',data:{}});
    expect(await answer(410,'Unregistered')).toEqual({kind:'unregistered'});
    expect(await answer(400,'BadDeviceToken')).toEqual({kind:'unregistered'});
    expect(await answer(403,'InvalidProviderToken')).toEqual({kind:'failed',code:'apns_invalid_key'});
    expect(await answer(403,'ExpiredProviderToken')).toEqual({kind:'retry',code:'apns_auth'});
    expect(await answer(400,'DeviceTokenNotForTopic')).toEqual({kind:'failed',code:'apns_DeviceTokenNotForTopic'});
    expect(await answer(503)).toMatchObject({kind:'retry',code:'http_503'});
    const offline=new ApnsSender(credentials,async()=>{throw new Error('offline');});
    expect(await offline.send(apnsStoredToken('production',TOPIC,TOKEN),{title:'Josi',body:'x',data:{}})).toEqual({kind:'retry',code:'network'});
    expect(await new ApnsSender(credentials,apple(()=>({status:400,body:'{"reason":"BadDeviceToken"}'})).transport).check()).toBe('accepted');
    expect(await new ApnsSender(credentials,apple(()=>({status:403,body:'{"reason":"InvalidProviderToken"}'})).transport).check()).toBe('rejected');
    expect(await offline.check()).toBe('unknown');
  });

  it('refuses a key that is not an Apple key',()=>{
    expect(validateApnsCredentials({keyId:' abc123defg ',teamId:'lrh75yr6qw',privateKey:P8.replace(/\n/g,'\r\n')})).toEqual(credentials);
    expect(()=>validateApnsCredentials({...credentials,keyId:'short'})).toThrow(/Key ID/);
    expect(()=>validateApnsCredentials({...credentials,privateKey:'nonsense'})).toThrow(/whole \.p8/);
    const rsa=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'}).toString();
    expect(()=>validateApnsCredentials({...credentials,privateKey:rsa})).toThrow(/not an Apple/);
  });

  it('waits without a key, then delivers once the key is saved, sealed',async()=>{
    const {db,key,u,t}=await setup();
    const never=(async()=>{throw new Error('must not reach the old relay');}) as typeof fetch;
    expect(await processPushBatch(db,key,never)).toMatchObject({sent:0,retried:1});
    expect((await db.query<any>(`select status,last_error_code from push_deliveries`))[0]).toMatchObject({status:'retry',last_error_code:'apns_unconfigured'});
    await saveApplePushKey(db,key,{actorUserId:u.id,credentials,checked:'accepted'});
    expect(await applePushKeyStatus(db)).toMatchObject({configured:true,keyId:'ABC123DEFG',teamId:'LRH75YR6QW',checked:'accepted'});
    const [row]=await db.query<{credential_enc:string}>(`select credential_enc from server_push_keys`);expect(row.credential_enc).not.toContain('PRIVATE KEY');
    const {calls,transport}=apple(()=>({status:200}));
    const sender=await defaultApnsSender(db,key,transport);expect(sender).not.toBeNull();
    await db.query(`update push_deliveries set next_attempt_at=now()-interval '1 minute'`);
    expect(await processPushBatch(db,key,never,new Date(),50,undefined,sender)).toMatchObject({sent:1,accepted:1});
    expect(JSON.parse(calls[0].body)).toMatchObject({aps:{alert:{title:'Josi',body:'Your reply is ready.'}},data:{route:'turn',id:t.id}});
    expect((await db.query<any>(`select status from push_deliveries`))[0].status).toBe('provider_accepted');
    expect(await deleteApplePushKey(db,u.id)).toBe(true);expect(await defaultApnsSender(db,key,transport)).toBeNull();
  });

  it('forgets a phone Apple says is gone',async()=>{
    const {db,key,device}=await setup();
    const sender=new ApnsSender(credentials,apple(()=>({status:410,body:'{"reason":"Unregistered"}'})).transport);
    await processPushBatch(db,key,fetch,new Date(),50,undefined,sender);
    expect((await db.query<any>(`select revoked_at from mobile_devices where id=$1`,[device.id]))[0].revoked_at).not.toBeNull();
    expect((await db.query<any>(`select status,last_error_code from push_deliveries`))[0]).toMatchObject({status:'failed',last_error_code:'DeviceNotRegistered'});
  });
});
