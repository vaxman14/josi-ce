import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, Empty, ErrorNote, Input } from '@/components/ui';

type Developer = { id: string; provider: string; label: string; baseUrl: string; status: string; credentialSet: boolean };
type CustomApi = { id: string; name: string; baseUrl: string; authType: string; credentialSet: boolean; enabled: boolean; status: string };
type Mcp = { id: string; name: string; transport: string; endpoint: string; credentialSet: boolean; enabled: boolean; status: string };
type Skill = { id: string; name: string; description?: string; source_type: string; source: string; version?: string; publisher?: string; requested_capabilities: string[]; enabled: boolean; review_state: string };
type Overview = { developerConnections: Developer[]; customApis: CustomApi[]; mcpServers: Mcp[]; skills: Skill[] };

const SERVICES = [
  { id: 'github', label: 'GitHub', help: 'Repositories, issues, releases, and source workflows.' },
  { id: 'netlify', label: 'Netlify', help: 'Sites, deploys, domains, and build status.' },
  { id: 'vercel', label: 'Vercel', help: 'Projects, deployments, domains, and build status.' },
  { id: 'supabase', label: 'Supabase', help: 'Projects and approved database operations.' },
];

export function AdminExtensibility() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const importRef = useRef<HTMLInputElement>(null);
  const load = useCallback(async () => {
    try { setData(await api.get<Overview>('/admin/extensibility/overview')); }
    catch (err) { setError(message(err)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function disconnect(provider: string) {
    setError(''); await api.del(`/admin/extensibility/developer/${provider}`); await load();
  }

  async function exportConfiguration() {
    try {
      const bundle = await api.get<Record<string, unknown>>('/admin/extensibility/export');
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `josi-configuration-${new Date().toISOString().slice(0, 10)}.json`; a.click();
      URL.revokeObjectURL(url); setNotice('Configuration exported. Credentials were not included.');
    } catch (err) { setError(message(err)); }
  }

  async function importConfiguration(file: File) {
    setError(''); setNotice('');
    try {
      const bundle = JSON.parse(await file.text()) as Record<string, unknown>;
      const result = await api.post<{ reauthorize: Array<{ type: string; name: string }> }>('/admin/extensibility/import', { bundle });
      setNotice(result.reauthorize.length
        ? `Imported safely. Reconnect ${result.reauthorize.length} service${result.reauthorize.length === 1 ? '' : 's'} below.`
        : 'Imported safely. Review skills before enabling them.');
      await load();
    } catch (err) { setError(err instanceof SyntaxError ? 'That file is not valid JSON.' : message(err)); }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl space-y-5">
      <div><h1 className="text-xl font-semibold tracking-tight">Connections &amp; skills</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
          Add what Josi may use without exposing credentials or configuration files. Everything begins off,
          and actions that change or delete something still require approval.
        </p></div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {notice ? <p role="status" className="text-sm text-emerald-300">{notice}</p> : null}

      <Card><div className="flex flex-wrap items-center justify-between gap-3"><div><CardTitle>Move this Josi</CardTitle>
        <p className="text-sm text-muted-foreground">Export the setup, import it elsewhere, then reconnect credentials in one checklist.</p></div>
        <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={() => void exportConfiguration()}>Export configuration</Button>
          <Button variant="secondary" onClick={() => importRef.current?.click()}>Import configuration</Button>
          <input ref={importRef} className="hidden" type="file" accept="application/json,.json" onChange={(e) => {
            const file = e.target.files?.[0]; if (file) void importConfiguration(file); e.currentTarget.value = '';
          }} /></div></div>
        <p className="mt-3 text-xs text-muted-foreground">Credentials never enter the export. The original installation remains unchanged if validation fails.</p>
      </Card>

      <section className="space-y-3"><div><h2 className="text-lg font-semibold">Developer services</h2>
        <p className="text-sm text-muted-foreground">Nothing is preset. Connect only the services this household uses.</p></div>
        <div className="grid gap-3 md:grid-cols-2">{SERVICES.map((service) => {
          const existing = data?.developerConnections.find((item) => item.provider === service.id);
          return <DeveloperCard key={service.id} service={service} existing={existing} onSaved={load} onDisconnect={disconnect} />;
        })}</div>
      </section>

      <section className="space-y-3"><div><h2 className="text-lg font-semibold">Custom APIs</h2>
        <p className="text-sm text-muted-foreground">Define the service, then allow individual operations. Josi never gets arbitrary request access.</p></div>
        <CustomApiForm onSaved={load} />
        {!data?.customApis.length ? <Empty title="No custom APIs"><span>Add one only when you know what Josi should do with it.</span></Empty>
          : data.customApis.map((item) => <CustomApiCard key={item.id} item={item} onChanged={load} />)}
      </section>

      <section className="space-y-3"><div><h2 className="text-lg font-semibold">MCP servers</h2>
        <p className="text-sm text-muted-foreground">Register a server, inspect its tools, and enable tools one at a time.</p></div>
        <McpForm onSaved={load} />
        {!data?.mcpServers.length ? <Empty title="No third-party MCP servers"><span>Josi’s private internal MCP boundary remains separate.</span></Empty>
          : data.mcpServers.map((item) => <McpCard key={item.id} item={item} onChanged={load} />)}
      </section>

      <section className="space-y-3"><div><h2 className="text-lg font-semibold">Skills library</h2>
        <p className="text-sm text-muted-foreground">Stage a skill, read what it asks for, then approve it. Installation never grants new permissions.</p></div>
        <SkillForm onSaved={load} />
        {!data?.skills.length ? <Empty title="No skills installed"><span>Curated starter skills can be added later without silently enabling them.</span></Empty>
          : data.skills.map((skill) => <SkillCard key={skill.id} skill={skill} onChanged={load} />)}
      </section>
    </div>
  );
}

function DeveloperCard({ service, existing, onSaved, onDisconnect }: {
  service: { id: string; label: string; help: string }; existing?: Developer;
  onSaved: () => Promise<void>; onDisconnect: (provider: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false); const [credential, setCredential] = useState(''); const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? ''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function save() { setBusy(true); setError(''); try {
    await api.put(`/admin/extensibility/developer/${service.id}`, { credential, baseUrl }); setCredential(''); setOpen(false); await onSaved();
  } catch (err) { setError(message(err)); } finally { setBusy(false); } }
  return <Card><div className="flex items-start justify-between gap-2"><div><CardTitle>{service.label}</CardTitle><p className="text-sm text-muted-foreground">{service.help}</p></div>
    <Badge tone={existing?.credentialSet ? 'ok' : 'muted'}>{existing?.credentialSet ? 'configured' : 'not connected'}</Badge></div>
    {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}
    {open ? <div className="mt-3 space-y-2">{service.id === 'supabase' ? <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://project.supabase.co" aria-label="Project URL" /> : null}
      <Input type="password" value={credential} onChange={(e) => setCredential(e.target.value)} placeholder="Access token" autoComplete="new-password" aria-label={`${service.label} access token`} />
      <p className="text-xs text-muted-foreground">Stored encrypted. Never shown again or passed through chat.</p>
      <div className="flex gap-2"><Button onClick={() => void save()} disabled={busy || !credential}>{busy ? 'Saving…' : 'Save securely'}</Button><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div></div>
      : <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" onClick={() => setOpen(true)}>{existing ? 'Reconnect' : 'Connect'}</Button>
        {existing?.credentialSet ? <Button variant="secondary" onClick={() => void api.post(`/admin/extensibility/developer/${service.id}/test`).then(onSaved).catch((e)=>setError(message(e)))}>Test connection</Button> : null}
        {existing ? <Button variant="danger" onClick={() => void onDisconnect(service.id)}>Disconnect</Button> : null}</div>}
  </Card>;
}

function CustomApiForm({ onSaved }: { onSaved: () => Promise<void> }) {
  const [open,setOpen]=useState(false); const [name,setName]=useState(''); const [baseUrl,setBaseUrl]=useState(''); const [authType,setAuthType]=useState('none'); const [credential,setCredential]=useState(''); const [error,setError]=useState('');
  async function save(){try{await api.post('/admin/extensibility/custom-apis',{name,baseUrl,authType,credential});setName('');setBaseUrl('');setCredential('');setOpen(false);await onSaved();}catch(e){setError(message(e));}}
  if(!open)return <Button variant="secondary" onClick={()=>setOpen(true)}>Add custom API</Button>;
  return <Card><CardTitle>Add custom API</CardTitle>{error?<ErrorNote>{error}</ErrorNote>:null}<div className="mt-3 grid gap-2 sm:grid-cols-2"><Input value={name} onChange={e=>setName(e.target.value)} placeholder="Service name"/><Input value={baseUrl} onChange={e=>setBaseUrl(e.target.value)} placeholder="https://api.example.com"/>
    <label className="text-sm">Authentication<select className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3" value={authType} onChange={e=>setAuthType(e.target.value)}><option value="none">None</option><option value="api_key">API key</option><option value="bearer">Bearer token</option><option value="basic">Basic auth</option><option value="oauth">OAuth credential</option></select></label>
    {authType!=='none'?<Input type="password" value={credential} onChange={e=>setCredential(e.target.value)} placeholder="Credential" autoComplete="new-password"/>:null}</div><div className="mt-3 flex gap-2"><Button onClick={()=>void save()}>Stage for review</Button><Button variant="ghost" onClick={()=>setOpen(false)}>Cancel</Button></div></Card>;
}

function CustomApiCard({item,onChanged}:{item:CustomApi;onChanged:()=>Promise<void>}){const [actions,setActions]=useState<any[]>([]);const [name,setName]=useState('');const [method,setMethod]=useState('GET');const [path,setPath]=useState('');
  const load=useCallback(()=>api.get<{actions:any[]}>(`/admin/extensibility/custom-apis/${item.id}/actions`).then(r=>setActions(r.actions)),[item.id]);useEffect(()=>{void load();},[load]);
  return <Card><div className="flex justify-between gap-2"><div><CardTitle>{item.name}</CardTitle><p className="break-all text-sm text-muted-foreground">{item.baseUrl}</p></div><Badge tone={item.enabled?'ok':'muted'}>{item.enabled?'ready':'review required'}</Badge></div>
    <div className="mt-3 space-y-2">{actions.map(a=><div key={a.id} className="flex flex-wrap items-center gap-2 border-t border-border pt-2"><code className="text-xs">{a.method} {a.path_template}</code><Badge>{a.kind}</Badge><Button variant="secondary" onClick={()=>void api.patch(`/admin/extensibility/custom-apis/${item.id}/actions/${a.id}`,{enabled:!a.enabled}).then(load)}>{a.enabled?'Disable':'Enable'}</Button></div>)}</div>
    <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_7rem_1fr_auto]"><Input value={name} onChange={e=>setName(e.target.value)} placeholder="Action name"/><select className="min-h-11 rounded-md border border-input bg-background px-2" value={method} onChange={e=>setMethod(e.target.value)}>{['GET','HEAD','POST','PUT','PATCH','DELETE'].map(m=><option key={m}>{m}</option>)}</select><Input value={path} onChange={e=>setPath(e.target.value)} placeholder="/v1/items"/><Button onClick={()=>void api.post(`/admin/extensibility/custom-apis/${item.id}/actions`,{name,method,path}).then(()=>{setName('');setPath('');return load();})}>Add</Button></div>
    <div className="mt-3 flex flex-wrap gap-2"><Button variant="secondary" onClick={()=>void api.post(`/admin/extensibility/custom-apis/${item.id}/test`).then(onChanged)}>Test connection</Button><Button variant="danger" onClick={()=>void api.del(`/admin/extensibility/custom-apis/${item.id}`).then(onChanged)}>Remove API</Button></div></Card>;
}

function McpForm({onSaved}:{onSaved:()=>Promise<void>}){const [open,setOpen]=useState(false);const [name,setName]=useState('');const [transport,setTransport]=useState('https');const [endpoint,setEndpoint]=useState('');const [credential,setCredential]=useState('');const [error,setError]=useState('');
  async function save(){try{await api.post('/admin/extensibility/mcp-servers',{name,transport,endpoint,credential});setOpen(false);setName('');setEndpoint('');setCredential('');await onSaved();}catch(e){setError(message(e));}}
  if(!open)return <Button variant="secondary" onClick={()=>setOpen(true)}>Add MCP server</Button>;return <Card><CardTitle>Add MCP server</CardTitle>{error?<ErrorNote>{error}</ErrorNote>:null}<div className="mt-3 grid gap-2 sm:grid-cols-2"><Input value={name} onChange={e=>setName(e.target.value)} placeholder="Server name"/><select className="min-h-11 rounded-md border border-input bg-background px-3" value={transport} onChange={e=>setTransport(e.target.value)}><option value="https">Remote HTTPS</option><option value="stdio">Local executable</option></select><Input value={endpoint} onChange={e=>setEndpoint(e.target.value)} placeholder={transport==='https'?'https://mcp.example.com':'/usr/local/bin/server'}/><Input type="password" value={credential} onChange={e=>setCredential(e.target.value)} placeholder="Optional credential" autoComplete="new-password"/></div><p className="mt-2 text-xs text-muted-foreground">Local executables receive no inherited environment variables or installation secrets.</p><div className="mt-3 flex gap-2"><Button onClick={()=>void save()}>Stage for review</Button><Button variant="ghost" onClick={()=>setOpen(false)}>Cancel</Button></div></Card>;
}

function McpCard({item,onChanged}:{item:Mcp;onChanged:()=>Promise<void>}){const [tools,setTools]=useState<any[]>([]);const [toolName,setToolName]=useState('');const [kind,setKind]=useState('read');const load=useCallback(()=>api.get<{tools:any[]}>(`/admin/extensibility/mcp-servers/${item.id}/tools`).then(r=>setTools(r.tools)),[item.id]);useEffect(()=>{void load();},[load]);
  return <Card><div className="flex justify-between gap-2"><div><CardTitle>{item.name}</CardTitle><p className="break-all text-sm text-muted-foreground">{item.transport}: {item.endpoint}</p></div><Badge tone={item.enabled?'ok':'muted'}>{item.enabled?'tools enabled':'review required'}</Badge></div>{tools.map(t=><div key={t.id} className="mt-2 flex flex-wrap items-center gap-2 border-t border-border pt-2"><span className="text-sm">{t.tool_name}</span><Badge>{t.kind}</Badge><Button variant="secondary" onClick={()=>void api.patch(`/admin/extensibility/mcp-servers/${item.id}/tools/${t.id}`,{enabled:!t.enabled}).then(load)}>{t.enabled?'Disable':'Enable'}</Button></div>)}
    <div className="mt-3 flex flex-wrap gap-2"><Input className="sm:max-w-xs" value={toolName} onChange={e=>setToolName(e.target.value)} placeholder="Discovered tool name"/><select className="min-h-11 rounded-md border border-input bg-background px-3" value={kind} onChange={e=>setKind(e.target.value)}><option value="read">Read</option><option value="write">Write</option><option value="delete">Delete</option></select><Button onClick={()=>void api.post(`/admin/extensibility/mcp-servers/${item.id}/tools`,{toolName,kind}).then(()=>{setToolName('');return load();})}>Add tool</Button></div><div className="mt-3 flex flex-wrap gap-2">{item.transport==='https'?<Button variant="secondary" onClick={()=>void api.post(`/admin/extensibility/mcp-servers/${item.id}/discover`).then(load)}>Discover tools</Button>:null}<Button variant="danger" onClick={()=>void api.del(`/admin/extensibility/mcp-servers/${item.id}`).then(onChanged)}>Remove server</Button></div></Card>;
}

function SkillForm({onSaved}:{onSaved:()=>Promise<void>}){const [open,setOpen]=useState(false);const [name,setName]=useState('');const [source,setSource]=useState('');const [caps,setCaps]=useState('');const [error,setError]=useState('');async function save(){try{await api.post('/admin/extensibility/skills',{name,source,sourceType:'repository',requestedCapabilities:caps.split(',').map(x=>x.trim()).filter(Boolean)});setOpen(false);setName('');setSource('');setCaps('');await onSaved();}catch(e){setError(message(e));}}if(!open)return <Button variant="secondary" onClick={()=>setOpen(true)}>Add skill</Button>;return <Card><CardTitle>Stage a skill</CardTitle>{error?<ErrorNote>{error}</ErrorNote>:null}<div className="mt-3 space-y-2"><Input value={name} onChange={e=>setName(e.target.value)} placeholder="Skill name"/><Input value={source} onChange={e=>setSource(e.target.value)} placeholder="https://github.com/publisher/repository"/><Input value={caps} onChange={e=>setCaps(e.target.value)} placeholder="Requested capabilities, comma separated"/></div><div className="mt-3 flex gap-2"><Button onClick={()=>void save()}>Stage for review</Button><Button variant="ghost" onClick={()=>setOpen(false)}>Cancel</Button></div></Card>}

function SkillCard({skill,onChanged}:{skill:Skill;onChanged:()=>Promise<void>}){return <Card><div className="flex justify-between gap-2"><div><CardTitle>{skill.name}</CardTitle><p className="break-all text-sm text-muted-foreground">{String(skill.source)}</p>{skill.requested_capabilities?.length?<p className="mt-2 text-sm">Requests: {skill.requested_capabilities.join(', ')}</p>:<p className="mt-2 text-sm text-muted-foreground">Requests no declared capabilities.</p>}</div><Badge tone={skill.enabled?'ok':skill.review_state==='quarantined'?'danger':'muted'}>{skill.enabled?'enabled':skill.review_state}</Badge></div><div className="mt-3 flex flex-wrap gap-2"><Button onClick={()=>void api.patch(`/admin/extensibility/skills/${skill.id}`,{reviewState:'approved',enabled:true}).then(onChanged)}>Approve &amp; enable</Button><Button variant="secondary" onClick={()=>void api.patch(`/admin/extensibility/skills/${skill.id}`,{reviewState:'quarantined',enabled:false}).then(onChanged)}>Quarantine</Button><Button variant="danger" onClick={()=>void api.del(`/admin/extensibility/skills/${skill.id}`).then(onChanged)}>Remove</Button></div></Card>}

function message(err: unknown): string { return err instanceof ApiError || err instanceof Error ? err.message : 'That could not be completed.'; }
