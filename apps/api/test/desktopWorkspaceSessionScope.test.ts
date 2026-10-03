import {afterAll,beforeAll,describe,expect,it} from 'vitest';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {randomUUID} from 'node:crypto';
import {testDb,type TestDb} from '../../../packages/core/test/helpers.js';
import {createUser,ensureWorkspace} from './fixtures.js';
import {createApp} from '../src/app.js';

let db:TestDb,server:Server,base:string;
let userId:string;
const password='desktop-session-password';

function mergeJar(existing:string|undefined,setCookie:string[]){
  const jar=new Map<string,string>();
  for(const part of (existing??'').split(';')){const i=part.indexOf('=');if(i>0)jar.set(part.slice(0,i).trim(),part.slice(i+1).trim());}
  for(const raw of setCookie){const first=raw.split(';')[0],i=first.indexOf('=');if(i>0)jar.set(first.slice(0,i).trim(),first.slice(i+1).trim());}
  return [...jar].map(([key,value])=>`${key}=${value}`).join('; ');
}

async function call(path:string,options:{method?:string;body?:unknown;jar?:string}={}){
  const headers:Record<string,string>={'content-type':'application/json'};
  if(options.jar){headers.cookie=options.jar;const csrf=/(?:^|;\s*)josi_csrf=([^;]+)/.exec(options.jar)?.[1];if(csrf)headers['x-josi-csrf']=decodeURIComponent(csrf);}
  const response=await fetch(base+path,{method:options.method??'GET',headers,body:options.body===undefined?undefined:JSON.stringify(options.body)});
  return{status:response.status,body:await response.json().catch(()=>null),cookies:response.headers.getSetCookie?.()??[]};
}

async function signIn(){
  const csrf=await call('/api/auth/csrf');let jar=mergeJar(undefined,csrf.cookies);
  const login=await call('/api/auth/login',{method:'POST',body:{identifier:'desktop-scope',password},jar});
  expect(login.status).toBe(200);return mergeJar(jar,login.cookies);
}

beforeAll(async()=>{
  db=await testDb();await ensureWorkspace(db);
  userId=(await createUser(db,{email:'desktop-scope@test.invalid',username:'desktop-scope',role:'member',password})).id;
  server=createApp(db,{cookieSecure:false,appUrl:'http://localhost:3000'}).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});

describe('desktop workspace session scope',()=>{
  it('shows each signed-in desktop only its own local folders',async()=>{
    const mac=await signIn(),windows=await signIn();
    const macMapping=await call('/api/desktop-workspace/mappings',{method:'POST',jar:mac,body:{clientId:'desktop_macbook_abcdefghijkl',rootId:'root_macbook_abcdefghijkl',label:'MacBook MyStuff',writable:false}});
    expect(macMapping.status).toBe(201);
    expect((await call('/api/desktop-workspace/mappings',{method:'POST',jar:windows,body:{clientId:'desktop_windows_abcdefghijk',rootId:'root_windows_abcdefghijk',label:'Windows Documents',writable:true}})).status).toBe(201);

    const macList=await call('/api/desktop-workspace/mappings',{jar:mac});
    const windowsList=await call('/api/desktop-workspace/mappings',{jar:windows});
    expect(macList.body.mappings.map((mapping:{label:string})=>mapping.label)).toEqual(['MacBook MyStuff']);
    expect(windowsList.body.mappings.map((mapping:{label:string})=>mapping.label)).toEqual(['Windows Documents']);
    expect(JSON.stringify(windowsList.body)).not.toContain('MacBook MyStuff');

    const requestId=randomUUID();
    await db.query(`insert into desktop_workspace_requests(id,owner_user_id,mapping_id,operation,payload,expires_at)
      values($1,$2,$3,'list','{}',now()+interval '1 minute')`,[requestId,userId,macMapping.body.mapping.id]);
    const wrongPoll=await call('/api/desktop-workspace/requests?clientId=desktop_windows_abcdefghijk',{jar:windows});
    expect(wrongPoll.body.request).toBeNull();
    const macPoll=await call('/api/desktop-workspace/requests?clientId=desktop_macbook_abcdefghijkl',{jar:mac});
    expect(macPoll.body.request.id).toBe(requestId);
    expect((await call(`/api/desktop-workspace/requests/${requestId}/result`,{method:'POST',jar:windows,body:{clientId:'desktop_macbook_abcdefghijkl',ok:true,result:{entries:[]}}})).status).toBe(404);
    expect((await call(`/api/desktop-workspace/requests/${requestId}/result`,{method:'POST',jar:mac,body:{clientId:'desktop_macbook_abcdefghijkl',ok:true,result:{entries:[]}}})).status).toBe(200);
  });
});
