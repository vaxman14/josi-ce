// Administrator-facing extensibility registry.
//
// This is intentionally boring: credentials go through the same sealed broker,
// imported configuration is inert, and nothing becomes executable merely
// because somebody pasted a URL or repository name into a form.
import { Router, type Request, type Response } from 'express';
import {
  appendEvent, asSecret, json, loadMasterKey, openSealed, seal,
  type Db, type LoadOptions, type MasterKey,
} from '@josi-ce/core';
import { safeFetch, UnsafeEndpointError, validateEndpoint } from '@josi-ce/llm';
import { asyncRoute, param } from './async.js';
import { requireSuperAdmin } from './authz.js';

export interface ExtensibilityRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  fetchImpl?: typeof fetch;
  resolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const str = (v: unknown, max = 500): string => typeof v === 'string' ? v.trim().slice(0, max) : '';
const uuid = (v: unknown): string => /^[0-9a-f-]{36}$/i.test(str(v, 40)) ? str(v, 40) : '';
const DEVELOPERS = ['github', 'netlify', 'vercel', 'supabase'] as const;
const AUTH_TYPES = ['none', 'api_key', 'bearer', 'basic', 'oauth'] as const;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

function keyFor(ctx: ExtensibilityRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'secure credential storage is unavailable');
  try { return loadMasterKey(ctx.masterKey ?? {}); }
  catch { throw new RouteError(503, 'the installation master key is missing or unusable'); }
}

function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return asyncRoute(async (req, res) => {
    try { return await fn(req, res); }
    catch (err) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof UnsafeEndpointError) return res.status(400).json({ error: err.message });
      throw err;
    }
  });
}

function credentialPayload(body: unknown): Record<string, ReturnType<typeof asSecret>> | null {
  const value = str((body as { credential?: unknown })?.credential, 16_000);
  const username = str((body as { username?: unknown })?.username, 500);
  if (!value && !username) return null;
  return { credential: asSecret(value), username: asSecret(username) };
}

function publicDeveloper(row: Record<string, unknown>) {
  return {
    id: row.id, provider: row.provider, label: row.label, baseUrl: row.base_url,
    status: row.status, credentialSet: Boolean(row.credential_enc),
    lastCheckAt: row.last_check_at, lastCheckOk: row.last_check_ok,
    lastErrorCategory: row.last_error_category,
  };
}

function publicApi(row: Record<string, unknown>) {
  return {
    id: row.id, name: row.name, baseUrl: row.base_url, authType: row.auth_type,
    credentialSet: Boolean(row.credential_enc), enabled: row.enabled, status: row.status,
    openapiSourceUrl: row.openapi_source_url,
  };
}

function publicMcp(row: Record<string, unknown>) {
  return {
    id: row.id, name: row.name, transport: row.transport, endpoint: row.endpoint,
    credentialSet: Boolean(row.credential_enc), enabled: row.enabled, status: row.status,
    lastCheckAt: row.last_check_at, lastCheckOk: row.last_check_ok,
  };
}

type StoredCredential = { credential?: string; username?: string };
function openCredential(ctx: ExtensibilityRoutesCtx, sealed: unknown): StoredCredential {
  if (typeof sealed !== 'string' || !sealed) throw new RouteError(409, 'connect a credential first');
  return openSealed<StoredCredential>(keyFor(ctx), sealed);
}

function authorizationHeaders(authType: string, stored: StoredCredential): Record<string, string> {
  const credential = stored.credential ?? '';
  if (authType === 'bearer' || authType === 'oauth') return { Authorization: `Bearer ${credential}` };
  if (authType === 'api_key') return { 'X-API-Key': credential };
  if (authType === 'basic') return { Authorization: `Basic ${Buffer.from(`${stored.username ?? ''}:${credential}`).toString('base64')}` };
  return {};
}

const MAX_DISCOVERY_BYTES = 1024 * 1024;
async function boundedJson(response: globalThis.Response, maxBytes = MAX_DISCOVERY_BYTES): Promise<unknown> {
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw new RouteError(409, 'the MCP response was too large');
  if (!response.body) return null;
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new RouteError(409, 'the MCP response was too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new RouteError(409, 'the MCP server returned an invalid response'); }
}

export function extensibilityRoutes(ctx: ExtensibilityRoutesCtx): Router {
  const r = Router();
  r.use(requireSuperAdmin);

  r.get('/overview', handle(async (_req, res) => {
    const [developers, apis, mcp, skills] = await Promise.all([
      ctx.db.query<Record<string, unknown>>(`select * from developer_connections order by provider`),
      ctx.db.query<Record<string, unknown>>(`select * from custom_apis order by name`),
      ctx.db.query<Record<string, unknown>>(`select * from mcp_servers order by name`),
      ctx.db.query<Record<string, unknown>>(`select id, name, description, source_type, source, version,
        publisher, integrity_sha256, requested_capabilities, enabled, review_state, installed_at
        from installed_skills order by name`),
    ]);
    return res.json({
      developerConnections: developers.map(publicDeveloper), customApis: apis.map(publicApi),
      mcpServers: mcp.map(publicMcp), skills,
    });
  }));

  r.put('/developer/:provider', handle(async (req, res) => {
    const provider = param(req, 'provider');
    if (!(DEVELOPERS as readonly string[]).includes(provider)) throw new RouteError(404, 'unknown service');
    const label = str(req.body?.label, 100) || provider[0].toUpperCase() + provider.slice(1);
    const defaultUrl: Record<string, string> = {
      github: 'https://api.github.com', netlify: 'https://api.netlify.com',
      vercel: 'https://api.vercel.com', supabase: '',
    };
    const baseUrl = str(req.body?.baseUrl, 2000) || defaultUrl[provider];
    if (!baseUrl) throw new RouteError(400, 'enter the Supabase project URL');
    await validateEndpoint(baseUrl, { resolve: ctx.resolve });
    const credential = credentialPayload(req.body);
    const sealed = credential ? seal(keyFor(ctx), credential) : null;
    const [row] = await ctx.db.query<Record<string, unknown>>(
      `insert into developer_connections
       (provider, label, base_url, credential_enc, status, configured_by)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (provider) do update set label=excluded.label, base_url=excluded.base_url,
         credential_enc=coalesce(excluded.credential_enc, developer_connections.credential_enc),
         status=case when coalesce(excluded.credential_enc, developer_connections.credential_enc) is null
           then 'needs_authentication' else 'disabled' end, configured_by=excluded.configured_by
       returning *`,
      [provider, label, baseUrl.replace(/\/$/, ''), sealed,
       sealed ? 'disabled' : 'needs_authentication', req.user!.id],
    );
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.developer.saved',
      subjectType: 'developer_connection', subjectId: String(row.id), payload: { provider } });
    return res.json(publicDeveloper(row));
  }));

  r.delete('/developer/:provider', handle(async (req, res) => {
    const provider = param(req, 'provider');
    const [row] = await ctx.db.query<{ id: string }>(
      `delete from developer_connections where provider=$1 returning id`, [provider],
    );
    if (!row) throw new RouteError(404, 'not found');
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.developer.disconnected',
      subjectType: 'developer_connection', subjectId: row.id, payload: { provider } });
    return res.status(204).end();
  }));

  r.post('/developer/:provider/test', handle(async (req, res) => {
    const provider = param(req, 'provider');
    const [row] = await ctx.db.query<{ id: string; base_url: string; credential_enc: string | null }>(
      `select id,base_url,credential_enc from developer_connections where provider=$1`, [provider],
    );
    if (!row) throw new RouteError(404, 'not found');
    const stored = openCredential(ctx, row.credential_enc);
    const suffix: Record<string,string> = { github: '/user', netlify: '/api/v1/user', vercel: '/v2/user', supabase: '/rest/v1/' };
    const headers: Record<string,string> = provider === 'supabase'
      ? { apikey: stored.credential ?? '', Authorization: `Bearer ${stored.credential ?? ''}` }
      : { Authorization: `Bearer ${stored.credential ?? ''}`, Accept: 'application/json' };
    const response = await safeFetch(`${row.base_url.replace(/\/$/,'')}${suffix[provider] ?? ''}`,
      { method: 'GET', headers }, { resolve: ctx.resolve, fetchImpl: ctx.fetchImpl, timeoutMs: 10_000 });
    const ok = response.ok;
    await ctx.db.query(`update developer_connections set status=$2,last_check_at=now(),last_check_ok=$3,
      last_error_category=$4 where id=$1`, [row.id, ok ? 'connected' : 'error', ok, ok ? null : `http_${response.status}`]);
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.developer.tested',
      subjectType: 'developer_connection', subjectId: row.id, payload: { provider, ok, statusCode: response.status } });
    if (!ok) throw new RouteError(409, 'the service rejected that credential');
    return res.json({ ok: true });
  }));

  r.post('/custom-apis', handle(async (req, res) => {
    const name = str(req.body?.name, 120);
    const baseUrl = str(req.body?.baseUrl, 2000).replace(/\/$/, '');
    const authType = str(req.body?.authType, 30) || 'none';
    if (!name || !baseUrl) throw new RouteError(400, 'name and base URL are required');
    if (!(AUTH_TYPES as readonly string[]).includes(authType)) throw new RouteError(400, 'unsupported authentication type');
    await validateEndpoint(baseUrl, { resolve: ctx.resolve });
    const credential = credentialPayload(req.body);
    if (authType !== 'none' && !credential) throw new RouteError(400, 'this authentication type needs a credential');
    const [row] = await ctx.db.query<Record<string, unknown>>(
      `insert into custom_apis
       (name,base_url,auth_type,credential_enc,status,openapi_source_url,configured_by)
       values ($1,$2,$3,$4,'needs_review',$5,$6) returning *`,
      [name, baseUrl, authType, credential ? seal(keyFor(ctx), credential) : null,
       str(req.body?.openapiSourceUrl, 2000) || null, req.user!.id],
    );
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.custom_api.created',
      subjectType: 'custom_api', subjectId: String(row.id), payload: { authType } });
    return res.status(201).json(publicApi(row));
  }));

  r.post('/custom-apis/:id/actions', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); if (!id) throw new RouteError(404, 'not found');
    const method = str(req.body?.method, 10).toUpperCase();
    const path = str(req.body?.path, 1000);
    const name = str(req.body?.name, 120);
    if (!(METHODS as readonly string[]).includes(method) || !path.startsWith('/') || !name) {
      throw new RouteError(400, 'enter a name, supported method, and path beginning with /');
    }
    const kind = method === 'GET' || method === 'HEAD' ? 'read' : method === 'DELETE' ? 'delete' : 'write';
    const [row] = await ctx.db.query(
      `insert into custom_api_actions (api_id,name,method,path_template,kind,approval_required)
       select $1,$2,$3,$4,$5,$6 where exists(select 1 from custom_apis where id=$1)
       returning id,name,method,path_template,kind,enabled,approval_required`,
      [id, name, method, path, kind, kind !== 'read'],
    );
    if (!row) throw new RouteError(404, 'not found');
    return res.status(201).json(row);
  }));

  r.get('/custom-apis/:id/actions', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); if (!id) throw new RouteError(404, 'not found');
    return res.json({ actions: await ctx.db.query(
      `select id,name,method,path_template,kind,enabled,approval_required
       from custom_api_actions where api_id=$1 order by name`, [id],
    ) });
  }));

  r.patch('/custom-apis/:id/actions/:actionId', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); const actionId = uuid(param(req, 'actionId'));
    const enabled = req.body?.enabled === true;
    const [row] = await ctx.db.query(
      `update custom_api_actions set enabled=$3 where id=$2 and api_id=$1
       returning id,name,method,path_template,kind,enabled,approval_required`, [id, actionId, enabled],
    );
    if (!row) throw new RouteError(404, 'not found');
    await ctx.db.query(`update custom_apis set enabled=exists(select 1 from custom_api_actions where api_id=$1 and enabled),
      status='ready' where id=$1`, [id]);
    return res.json(row);
  }));

  r.delete('/custom-apis/:id', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); if (!id) throw new RouteError(404, 'not found');
    const [row] = await ctx.db.query<{ id: string }>(`delete from custom_apis where id=$1 returning id`, [id]);
    if (!row) throw new RouteError(404, 'not found');
    return res.status(204).end();
  }));

  r.post('/custom-apis/:id/test', handle(async (req, res) => {
    const id = uuid(param(req,'id')); if (!id) throw new RouteError(404,'not found');
    const [row] = await ctx.db.query<{ base_url:string; auth_type:string; credential_enc:string|null }>(
      `select base_url,auth_type,credential_enc from custom_apis where id=$1`, [id]);
    if (!row) throw new RouteError(404,'not found');
    const stored = row.auth_type === 'none' ? {} : openCredential(ctx,row.credential_enc);
    const response = await safeFetch(row.base_url,{method:'GET',headers:authorizationHeaders(row.auth_type,stored)},
      {resolve:ctx.resolve,fetchImpl:ctx.fetchImpl,timeoutMs:10_000});
    await ctx.db.query(`update custom_apis set status=$2 where id=$1`,[id,response.ok?'needs_review':'error']);
    if(!response.ok) throw new RouteError(409,'the API rejected the connection test');
    return res.json({ok:true,statusCode:response.status});
  }));

  r.post('/mcp-servers', handle(async (req, res) => {
    const name = str(req.body?.name, 120); const transport = str(req.body?.transport, 20);
    const endpoint = str(req.body?.endpoint, 2000);
    if (!name || !['https', 'stdio'].includes(transport) || !endpoint) throw new RouteError(400, 'name, transport, and endpoint are required');
    if (transport === 'https') await validateEndpoint(endpoint, { resolve: ctx.resolve });
    if (transport === 'stdio' && (!endpoint.startsWith('/') || /[;&|`$<>\n\r]/.test(endpoint))) {
      throw new RouteError(400, 'local MCP commands must be an absolute executable path without shell syntax');
    }
    const credential = credentialPayload(req.body);
    const [row] = await ctx.db.query<Record<string, unknown>>(
      `insert into mcp_servers (name,transport,endpoint,credential_enc,status,configured_by)
       values ($1,$2,$3,$4,'needs_review',$5) returning *`,
      [name, transport, endpoint, credential ? seal(keyFor(ctx), credential) : null, req.user!.id],
    );
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.mcp.created',
      subjectType: 'mcp_server', subjectId: String(row.id), payload: { transport } });
    return res.status(201).json(publicMcp(row));
  }));

  r.post('/mcp-servers/:id/tools', handle(async (req, res) => {
    const serverId = uuid(param(req, 'id')); const toolName = str(req.body?.toolName, 200);
    const kind = str(req.body?.kind, 20) || 'write';
    if (!serverId || !toolName || !['read', 'write', 'delete'].includes(kind)) throw new RouteError(400, 'valid server, tool name, and classification required');
    const [row] = await ctx.db.query(
      `insert into mcp_tools (server_id,tool_name,description,kind,approval_required)
       select $1,$2,$3,$4,$5 where exists(select 1 from mcp_servers where id=$1)
       on conflict(server_id,tool_name) do update set description=excluded.description,kind=excluded.kind,
         enabled=false,approval_required=excluded.approval_required,discovered_at=now()
       returning id,tool_name,description,kind,enabled,approval_required`,
      [serverId, toolName, str(req.body?.description, 1000) || null, kind, kind !== 'read'],
    );
    if (!row) throw new RouteError(404, 'not found');
    return res.status(201).json(row);
  }));

  r.get('/mcp-servers/:id/tools', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); if (!id) throw new RouteError(404, 'not found');
    return res.json({ tools: await ctx.db.query(
      `select id,tool_name,description,kind,enabled,approval_required from mcp_tools where server_id=$1 order by tool_name`, [id],
    ) });
  }));

  r.patch('/mcp-servers/:id/tools/:toolId', handle(async (req, res) => {
    const serverId = uuid(param(req, 'id')); const toolId = uuid(param(req, 'toolId'));
    const [row] = await ctx.db.query(
      `update mcp_tools set enabled=$3 where server_id=$1 and id=$2
       returning id,tool_name,description,kind,enabled,approval_required`,
      [serverId, toolId, req.body?.enabled === true],
    );
    if (!row) throw new RouteError(404, 'not found');
    await ctx.db.query(`update mcp_servers set enabled=exists(select 1 from mcp_tools where server_id=$1 and enabled),
      status='ready' where id=$1`, [serverId]);
    return res.json(row);
  }));

  r.delete('/mcp-servers/:id', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); if (!id) throw new RouteError(404, 'not found');
    const [row] = await ctx.db.query<{ id: string }>(`delete from mcp_servers where id=$1 returning id`, [id]);
    if (!row) throw new RouteError(404, 'not found');
    return res.status(204).end();
  }));

  r.post('/mcp-servers/:id/discover', handle(async (req,res)=>{
    const id=uuid(param(req,'id'));if(!id)throw new RouteError(404,'not found');
    const [row]=await ctx.db.query<{endpoint:string;transport:string;credential_enc:string|null}>(
      `select endpoint,transport,credential_enc from mcp_servers where id=$1`,[id]);
    if(!row)throw new RouteError(404,'not found');
    if(row.transport!=='https')throw new RouteError(409,'local MCP discovery runs inside the installed worker, not the browser API');
    const stored=row.credential_enc?openCredential(ctx,row.credential_enc):{};
    const headers:Record<string,string>={'Content-Type':'application/json','Accept':'application/json, text/event-stream'};
    if(stored.credential)headers.Authorization=`Bearer ${stored.credential}`;
    const response=await safeFetch(row.endpoint,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list',params:{}})},
      {resolve:ctx.resolve,fetchImpl:ctx.fetchImpl,timeoutMs:10_000});
    if(!response.ok){await ctx.db.query(`update mcp_servers set status='error',last_check_at=now(),last_check_ok=false where id=$1`,[id]);throw new RouteError(409,'the MCP server rejected tool discovery');}
    const body=await boundedJson(response) as {result?:{tools?:Array<{name?:unknown;description?:unknown}>}}|null;
    const tools=Array.isArray(body?.result?.tools)?body!.result!.tools!.slice(0,500):[];
    for(const tool of tools){const name=str(tool?.name,200);if(!name)continue;await ctx.db.query(
      `insert into mcp_tools(server_id,tool_name,description,kind,enabled,approval_required)
       values($1,$2,$3,'write',false,true) on conflict(server_id,tool_name) do update set
       description=excluded.description,enabled=false,discovered_at=now()`,[id,name,str(tool?.description,1000)||null]);}
    await ctx.db.query(`update mcp_servers set status='needs_review',last_check_at=now(),last_check_ok=true where id=$1`,[id]);
    await appendEvent(ctx.db,{actorUserId:req.user!.id,kind:'extensibility.mcp.discovered',subjectType:'mcp_server',subjectId:id,payload:{toolCount:tools.length}});
    return res.json({ok:true,toolCount:tools.length,toolsDefault:'disabled'});
  }));

  r.post('/skills', handle(async (req, res) => {
    const name = str(req.body?.name, 120); const source = str(req.body?.source, 2000);
    const sourceType = str(req.body?.sourceType, 30) || 'repository';
    if (!name || !source || !['curated', 'repository', 'local'].includes(sourceType)) throw new RouteError(400, 'name and a supported source are required');
    if (sourceType === 'repository' && !/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(?:\/.*)?$/.test(source)) {
      throw new RouteError(400, 'repository skills must use an HTTPS GitHub URL');
    }
    const requested = Array.isArray(req.body?.requestedCapabilities)
      ? req.body.requestedCapabilities.map((v: unknown) => str(v, 100)).filter(Boolean).slice(0, 50) : [];
    const [row] = await ctx.db.query(
      `insert into installed_skills
       (name,description,source_type,source,version,publisher,integrity_sha256,requested_capabilities,installed_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       returning id,name,description,source_type,source,version,publisher,integrity_sha256,
         requested_capabilities,enabled,review_state,installed_at`,
      [name, str(req.body?.description, 1000) || null, sourceType, source,
       str(req.body?.version, 100) || null, str(req.body?.publisher, 200) || null,
       str(req.body?.integritySha256, 64) || null, json(requested), req.user!.id],
    );
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.skill.staged',
      subjectType: 'skill', subjectId: String((row as { id: unknown }).id), payload: { sourceType, capabilityCount: requested.length } });
    return res.status(201).json(row);
  }));

  r.patch('/skills/:id', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); const reviewState = str(req.body?.reviewState, 30);
    if (!id || !['pending', 'approved', 'quarantined', 'rejected'].includes(reviewState)) throw new RouteError(400, 'choose a valid review state');
    const enabled = reviewState === 'approved' && req.body?.enabled === true;
    const [row] = await ctx.db.query(
      `update installed_skills set review_state=$2,enabled=$3 where id=$1
       returning id,name,description,source_type,source,version,publisher,integrity_sha256,
         requested_capabilities,enabled,review_state,installed_at`, [id, reviewState, enabled],
    );
    if (!row) throw new RouteError(404, 'not found');
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.skill.reviewed',
      subjectType: 'skill', subjectId: id, payload: { reviewState, enabled } });
    return res.json(row);
  }));

  r.delete('/skills/:id', handle(async (req, res) => {
    const id = uuid(param(req, 'id')); if (!id) throw new RouteError(404, 'not found');
    const [row] = await ctx.db.query<{ id: string }>(`delete from installed_skills where id=$1 returning id`, [id]);
    if (!row) throw new RouteError(404, 'not found');
    return res.status(204).end();
  }));

  // Safe config transfer: metadata and permissions move; credentials do not.
  r.get('/export', handle(async (_req, res) => {
    const [developerConnections, customApis, customApiActions, mcpServers, mcpTools, skills] = await Promise.all([
      ctx.db.query(`select provider,label,base_url from developer_connections order by provider`),
      ctx.db.query(`select id,name,base_url,auth_type,openapi_source_url from custom_apis order by name`),
      ctx.db.query(`select api_id,name,method,path_template,kind,approval_required from custom_api_actions order by api_id,name`),
      ctx.db.query(`select id,name,transport,endpoint from mcp_servers order by name`),
      ctx.db.query(`select server_id,tool_name,description,kind,approval_required from mcp_tools order by server_id,tool_name`),
      ctx.db.query(`select name,description,source_type,source,version,publisher,integrity_sha256,requested_capabilities from installed_skills order by name`),
    ]);
    return res.json({ format: 'josi-extensibility', version: 1, exportedAt: new Date().toISOString(),
      credentialsIncluded: false, developerConnections, customApis, customApiActions, mcpServers, mcpTools, skills });
  }));

  r.post('/import', handle(async (req, res) => {
    const bundle = req.body?.bundle ?? req.body;
    if (bundle?.format !== 'josi-extensibility' || bundle?.version !== 1) throw new RouteError(400, 'that is not a supported Josi configuration export');
    const developers = Array.isArray(bundle.developerConnections) ? bundle.developerConnections.slice(0, 20) : [];
    const apis = Array.isArray(bundle.customApis) ? bundle.customApis.slice(0, 100) : [];
    const apiActions = Array.isArray(bundle.customApiActions) ? bundle.customApiActions.slice(0, 1000) : [];
    const servers = Array.isArray(bundle.mcpServers) ? bundle.mcpServers.slice(0, 100) : [];
    const serverTools = Array.isArray(bundle.mcpTools) ? bundle.mcpTools.slice(0, 2000) : [];
    const skills = Array.isArray(bundle.skills) ? bundle.skills.slice(0, 250) : [];

    // Validate the complete network surface before the first write. This is
    // what keeps a bad last URL from leaving half an import behind.
    for (const raw of developers) {
      const baseUrl = str(raw?.base_url, 2000); if (baseUrl) await validateEndpoint(baseUrl, { resolve: ctx.resolve });
    }
    for (const raw of apis) {
      const baseUrl = str(raw?.base_url, 2000); if (baseUrl) await validateEndpoint(baseUrl, { resolve: ctx.resolve });
    }
    for (const raw of servers) {
      const transport = str(raw?.transport, 20); const endpoint = str(raw?.endpoint, 2000);
      if (transport === 'https' && endpoint) await validateEndpoint(endpoint, { resolve: ctx.resolve });
      if (transport === 'stdio' && (!endpoint.startsWith('/') || /[;&|`$<>\n\r]/.test(endpoint))) {
        throw new RouteError(400, 'an imported local MCP command is unsafe');
      }
    }

    const reauthorize: Array<{ type: string; name: string }> = [];
    for (const raw of developers) {
      const provider = str(raw?.provider, 30); const baseUrl = str(raw?.base_url, 2000);
      if (!(DEVELOPERS as readonly string[]).includes(provider) || !baseUrl) continue;
      await ctx.db.query(`insert into developer_connections(provider,label,base_url,status,configured_by)
        values($1,$2,$3,'needs_authentication',$4) on conflict(provider) do update set label=excluded.label,
        base_url=excluded.base_url,status=case when developer_connections.credential_enc is null
          then 'needs_authentication' else developer_connections.status end,configured_by=excluded.configured_by`,
      [provider, str(raw?.label, 100) || provider, baseUrl, req.user!.id]);
      const [saved] = await ctx.db.query<{ credential_enc: string | null }>(
        `select credential_enc from developer_connections where provider=$1`, [provider],
      );
      if (!saved?.credential_enc) reauthorize.push({ type: 'developer', name: provider });
    }
    for (const raw of apis) {
      const id = uuid(raw?.id); const name = str(raw?.name, 120); const baseUrl = str(raw?.base_url, 2000);
      if (!id || !name || !baseUrl) continue;
      const authType = (AUTH_TYPES as readonly string[]).includes(str(raw?.auth_type,30)) ? str(raw?.auth_type,30) : 'none';
      await ctx.db.query(`insert into custom_apis(id,name,base_url,auth_type,status,configured_by)
        values($1,$2,$3,$4,$5,$6) on conflict(id) do update set name=excluded.name,base_url=excluded.base_url,
        auth_type=excluded.auth_type,status=case when custom_apis.credential_enc is null and excluded.auth_type<>'none'
          then 'needs_authentication' else 'needs_review' end,enabled=false,configured_by=excluded.configured_by`,
      [id, name, baseUrl, authType, authType === 'none' ? 'needs_review' : 'needs_authentication', req.user!.id]);
      const [saved] = await ctx.db.query<{ credential_enc: string | null }>(`select credential_enc from custom_apis where id=$1`, [id]);
      if (authType !== 'none' && !saved?.credential_enc) reauthorize.push({ type: 'custom_api', name });
    }
    for (const raw of apiActions) {
      const apiId = uuid(raw?.api_id); const method = str(raw?.method,10).toUpperCase(); const path = str(raw?.path_template,1000);
      if (!apiId || !(METHODS as readonly string[]).includes(method) || !path.startsWith('/')) continue;
      const kind = ['read','write','delete'].includes(str(raw?.kind,20)) ? str(raw?.kind,20) : 'write';
      await ctx.db.query(`insert into custom_api_actions(api_id,name,method,path_template,kind,enabled,approval_required)
        select $1,$2,$3,$4,$5,false,$6 where exists(select 1 from custom_apis where id=$1)
        on conflict(api_id,method,path_template) do update set name=excluded.name,kind=excluded.kind,
          enabled=false,approval_required=excluded.approval_required`,
      [apiId, str(raw?.name,120)||`${method} ${path}`, method, path, kind, raw?.approval_required !== false]);
    }
    for (const raw of servers) {
      const id = uuid(raw?.id); const name = str(raw?.name, 120); const transport = str(raw?.transport, 20); const endpoint = str(raw?.endpoint, 2000);
      if (!id || !name || !['https','stdio'].includes(transport) || !endpoint) continue;
      await ctx.db.query(`insert into mcp_servers(id,name,transport,endpoint,status,configured_by)
        values($1,$2,$3,$4,'needs_authentication',$5) on conflict(id) do update set name=excluded.name,
        transport=excluded.transport,endpoint=excluded.endpoint,status=case when mcp_servers.credential_enc is null
          then 'needs_authentication' else 'needs_review' end,enabled=false,configured_by=excluded.configured_by`,
      [id, name, transport, endpoint, req.user!.id]);
      const [saved] = await ctx.db.query<{ credential_enc: string | null }>(`select credential_enc from mcp_servers where id=$1`, [id]);
      if (!saved?.credential_enc) reauthorize.push({ type: 'mcp', name });
    }
    for (const raw of serverTools) {
      const serverId = uuid(raw?.server_id); const toolName = str(raw?.tool_name,200);
      if (!serverId || !toolName) continue;
      const kind = ['read','write','delete'].includes(str(raw?.kind,20)) ? str(raw?.kind,20) : 'write';
      await ctx.db.query(`insert into mcp_tools(server_id,tool_name,description,kind,enabled,approval_required)
        select $1,$2,$3,$4,false,$5 where exists(select 1 from mcp_servers where id=$1)
        on conflict(server_id,tool_name) do update set description=excluded.description,kind=excluded.kind,
          enabled=false,approval_required=excluded.approval_required,discovered_at=now()`,
      [serverId, toolName, str(raw?.description,1000)||null, kind, raw?.approval_required !== false]);
    }
    for (const raw of skills) {
      const name = str(raw?.name, 120); const source = str(raw?.source, 2000); if (!name || !source) continue;
      await ctx.db.query(`insert into installed_skills(name,description,source_type,source,version,publisher,
        integrity_sha256,requested_capabilities,review_state,enabled,installed_by)
        values($1,$2,$3,$4,$5,$6,$7,$8,'pending',false,$9) on conflict(name) do update set
        description=excluded.description,source_type=excluded.source_type,source=excluded.source,
        version=excluded.version,publisher=excluded.publisher,integrity_sha256=excluded.integrity_sha256,
        requested_capabilities=excluded.requested_capabilities,review_state='pending',enabled=false`,
      [name, str(raw?.description,1000)||null, str(raw?.source_type,30)||'repository', source,
       str(raw?.version,100)||null, str(raw?.publisher,200)||null, str(raw?.integrity_sha256,64)||null,
       json(Array.isArray(raw?.requested_capabilities) ? raw.requested_capabilities.slice(0,50) : []), req.user!.id]);
    }
    await appendEvent(ctx.db, { actorUserId: req.user!.id, kind: 'extensibility.configuration.imported',
      subjectType: 'installation', payload: { reauthorizationCount: reauthorize.length } });
    return res.json({ imported: true, credentialsIncluded: false, reauthorize });
  }));

  return r;
}
