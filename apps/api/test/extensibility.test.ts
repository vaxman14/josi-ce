import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testDb, type TestDb } from '../../../packages/core/test/helpers.js';
import { looksSealed } from '@josi-ce/core';
import { createUser, ensureWorkspace } from './fixtures.js';
import { createApp } from '../src/app.js';

let db: TestDb; let server: Server; let base: string;
const cookies: Record<string, string> = {};
const keyPath = join(mkdtempSync(join(tmpdir(), 'josi-ext-')), 'master.key');
writeFileSync(keyPath, Buffer.alloc(32, 19).toString('base64'));
let remoteResponse = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
const connectorFetch = (async () => remoteResponse.clone()) as typeof fetch;

async function call(path: string, opts: { method?: string; body?: unknown; jar?: string } = {}) {
  const headers: Record<string,string> = { 'Content-Type': 'application/json' };
  if (opts.jar) { headers.cookie = opts.jar; const m = /josi_csrf=([^;]+)/.exec(opts.jar); if (m) headers['x-josi-csrf'] = decodeURIComponent(m[1]); }
  const res = await fetch(`${base}${path}`, { method: opts.method ?? 'GET', headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body), redirect: 'manual' });
  return { status: res.status, body: await res.json().catch(() => null), setCookie: res.headers.getSetCookie?.() ?? [] };
}
function merge(old: string | undefined, values: string[]) { const map = new Map<string,string>(); for (const piece of (old ?? '').split(';')) { const i=piece.indexOf('='); if(i>0)map.set(piece.slice(0,i).trim(),piece.slice(i+1).trim()); } for(const raw of values){const first=raw.split(';')[0];const i=first.indexOf('=');if(i>0)map.set(first.slice(0,i),first.slice(i+1));} return [...map].map(([k,v])=>`${k}=${v}`).join('; '); }
async function login(name:string,password:string){const pre=await call('/api/auth/csrf');let jar=merge(undefined,pre.setCookie);const out=await call('/api/auth/login',{method:'POST',body:{identifier:name,password},jar});expect(out.status).toBe(200);return merge(jar,out.setCookie);}

beforeAll(async()=>{db=await testDb();await ensureWorkspace(db);await createUser(db,{email:'admin@ce.test',username:'admin',role:'super_admin',password:'admin-password-123'});await createUser(db,{email:'member@ce.test',username:'member',role:'member',password:'member-password-123'});
  const app=createApp(db,{cookieSecure:false,appUrl:'http://localhost:3000',masterKeyCheck:{path:keyPath},connectorFetch,outboundResolve:async()=>['203.0.113.10']});await new Promise<void>(r=>{server=app.listen(0,'127.0.0.1',r)});base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;cookies.admin=await login('admin','admin-password-123');cookies.member=await login('member','member-password-123');});
afterAll(async()=>{if(server) await new Promise<void>(r=>server.close(()=>r()));});

describe('extensibility security boundary',()=>{
  it('is super-admin only',async()=>{expect((await call('/api/admin/extensibility/overview',{jar:cookies.member})).status).toBe(403);});
  it('seals service credentials and never returns them',async()=>{const secret='token-value-that-must-never-return';const saved=await call('/api/admin/extensibility/developer/github',{method:'PUT',jar:cookies.admin,body:{credential:secret}});expect(saved.status).toBe(200);expect(JSON.stringify(saved.body)).not.toContain(secret);const [row]=await db.query<{credential_enc:string}>(`select credential_enc from developer_connections where provider='github'`);expect(looksSealed(row.credential_enc)).toBe(true);const overview=await call('/api/admin/extensibility/overview',{jar:cookies.admin});expect(JSON.stringify(overview.body)).not.toContain(secret);expect(JSON.stringify(overview.body)).not.toContain(row.credential_enc);});
  it('keeps custom operations disabled until individually reviewed',async()=>{const api=await call('/api/admin/extensibility/custom-apis',{method:'POST',jar:cookies.admin,body:{name:'Example',baseUrl:'https://api.example.test',authType:'none'}});expect(api.status).toBe(201);expect(api.body.enabled).toBe(false);const action=await call(`/api/admin/extensibility/custom-apis/${api.body.id}/actions`,{method:'POST',jar:cookies.admin,body:{name:'List things',method:'GET',path:'/things'}});expect(action.status).toBe(201);expect(action.body.enabled).toBe(false);expect(action.body.kind).toBe('read');});
  it('exports no credentials and imports as inert reauthorization work',async()=>{const exported=await call('/api/admin/extensibility/export',{jar:cookies.admin});expect(exported.status).toBe(200);expect(exported.body.credentialsIncluded).toBe(false);expect(JSON.stringify(exported.body)).not.toMatch(/credential_enc|token-value/);await db.query(`delete from developer_connections`);const imported=await call('/api/admin/extensibility/import',{method:'POST',jar:cookies.admin,body:{bundle:exported.body}});expect(imported.status).toBe(200);expect(imported.body.reauthorize).toEqual(expect.arrayContaining([{type:'developer',name:'github'}]));const [row]=await db.query<{credential_enc:string|null;status:string}>(`select credential_enc,status from developer_connections where provider='github'`);expect(row.credential_enc).toBeNull();expect(row.status).toBe('needs_authentication');});
  it('stages skills disabled and requires an explicit approved review',async()=>{const staged=await call('/api/admin/extensibility/skills',{method:'POST',jar:cookies.admin,body:{name:'Example skill',source:'https://github.com/example/skill',requestedCapabilities:['calendar.read']}});expect(staged.status).toBe(201);expect(staged.body.enabled).toBe(false);expect(staged.body.review_state).toBe('pending');const reviewed=await call(`/api/admin/extensibility/skills/${staged.body.id}`,{method:'PATCH',jar:cookies.admin,body:{reviewState:'approved',enabled:true}});expect(reviewed.status).toBe(200);expect(reviewed.body.enabled).toBe(true);});
  it('rejects oversized remote MCP discovery before buffering the body',async()=>{const created=await call('/api/admin/extensibility/mcp-servers',{method:'POST',jar:cookies.admin,body:{name:'Large server',transport:'https',endpoint:'https://mcp.example.test'}});expect(created.status).toBe(201);remoteResponse=new Response('x',{status:200,headers:{'content-length':String(2*1024*1024)}});const discovered=await call(`/api/admin/extensibility/mcp-servers/${created.body.id}/discover`,{method:'POST',jar:cookies.admin});expect(discovered.status).toBe(409);expect(discovered.body.error).toMatch(/too large/i);});
});
