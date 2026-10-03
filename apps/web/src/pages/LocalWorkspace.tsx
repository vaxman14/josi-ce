import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { WorkspaceCode } from '@/components/WorkspaceCode';
import { Badge, Button, Card, Empty, ErrorNote, Input } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { desktopWorkspaceBridge, registerDesktopRoots, type DesktopRoot } from '@/lib/desktopWorkspace';

interface Mapping {
  id: string; provider: string; display_path: string; root_id?: string; writable?: boolean;
  may_create?: boolean; may_edit?: boolean; may_move?: boolean; may_delete?: boolean;
  status?: string; last_seen_at?: string;
}
interface Entry { name:string; kind:string; size?:number; modified?:string }
interface Change { operation:string; path:string; destination?:string; content?:string }

export function LocalWorkspace() {
  const [mappings,setMappings]=useState<Mapping[]>([]),[id,setId]=useState(''),[path,setPath]=useState(''),[entries,setEntries]=useState<Entry[]>([]),[filter,setFilter]=useState(''),[sort,setSort]=useState('asc');
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[preview,setPreview]=useState(''),[permissions,setPermissions]=useState<Record<string,boolean>>({});
  const [name,setName]=useState(''),[content,setContent]=useState(''),[destination,setDestination]=useState(''),[editing,setEditing]=useState(false),[pending,setPending]=useState<{id:string;change:Change}|null>(null),[receipt,setReceipt]=useState('');
  const [desktopRoots,setDesktopRoots]=useState<DesktopRoot[]>([]),[adding,setAdding]=useState(false);
  const bridge=desktopWorkspaceBridge();
  const selected=useMemo(()=>mappings.find(mapping=>mapping.id===id)??null,[mappings,id]);

  async function refreshMappings(){
    try{
      const [stored,desktop]=await Promise.all([
        api.get<{mappings:Mapping[]}>('/storage/mappings'),
        api.get<{mappings:Array<{id:string;root_id:string;label:string;writable:boolean;status:string;last_seen_at:string}>}>('/desktop-workspace/mappings'),
      ]);
      const next=[...stored.mappings.filter(mapping=>mapping.provider==='local'),...desktop.mappings.map(mapping=>({id:mapping.id,provider:'desktop',root_id:mapping.root_id,display_path:mapping.label,writable:mapping.writable,status:mapping.status,last_seen_at:mapping.last_seen_at}))];
      setMappings(next);
      setId(current=>current&&next.some(mapping=>mapping.id===current)?current:(next[0]?.id??''));
      return next;
    }catch(e){setError((e as Error).message);return [] as Mapping[];}
  }

  async function refreshDesktop(){
    if(!bridge)return refreshMappings();
    const state=await bridge.state();setDesktopRoots(state.roots);await registerDesktopRoots(state);return refreshMappings();
  }
  useEffect(()=>{void refreshDesktop().catch(e=>setError((e as Error).message));},[]);

  async function chooseFolder(writable:boolean){
    if(!bridge)return;setAdding(true);setError('');
    try{const root=await bridge.selectFolder(writable);if(!root)return;const next=await refreshDesktop();const mapping=next.find(candidate=>candidate.provider==='desktop'&&candidate.root_id===root.id);if(mapping){setId(mapping.id);setPath('');setEntries([]);}}
    catch(e){setError((e as Error).message);}finally{setAdding(false);}
  }
  async function revokeDesktop(rootId:string){
    if(!bridge)return;setBusy(true);setError('');
    try{await bridge.revoke(rootId);const mapping=mappings.find(candidate=>candidate.provider==='desktop'&&candidate.root_id===rootId);if(mapping){await api.del(`/desktop-workspace/mappings/${mapping.id}`);if(id===mapping.id)setId('');}await refreshDesktop();}
    catch(e){setError((e as Error).message);}finally{setBusy(false);}
  }
  async function refresh(){
    if(!id)return;setBusy(true);setError('');
    try{const data=await api.get<{entries:Entry[];permissions:Record<string,boolean>}>(`/workspace/${id}/list?path=${encodeURIComponent(path)}`);setEntries(data.entries);setPermissions(data.permissions);}
    catch(e){setEntries([]);setError((e as Error).message);}finally{setBusy(false);}
  }
  useEffect(()=>{setPreview('');setPending(null);if(id)void refresh();else{setEntries([]);setPermissions({});}},[id,path]);
  const full=(item:string)=>[path,item].filter(Boolean).join('/');
  async function propose(change:Change){setError('');try{const response=await api.post<{approval?:{id:string};receipt?:string;completed?:boolean}>(`/workspace/${id}/change`,change);if(response.approval)setPending({id:response.approval.id,change});else if(response.completed){setReceipt(response.receipt??'desktop');await refresh();}}catch(e){setError((e as Error).message);}}

  const selectedWritable=selected?.provider==='desktop'?selected.writable===true:[selected?.may_create,selected?.may_edit,selected?.may_move,selected?.may_delete].some(Boolean);
  const selectedRoot=selected?.root_id?desktopRoots.find(root=>root.id===selected.root_id):undefined;
  const filteredEntries=entries.filter(entry=>entry.name.toLowerCase().includes(filter.toLowerCase())).sort((a,b)=>(sort==='asc'?1:-1)*a.name.localeCompare(b.name));

  return <main className="mx-auto w-full max-w-6xl space-y-5 p-4 sm:p-6">
    <header className="space-y-1"><h1 className="text-2xl font-semibold tracking-tight">Local Workspace</h1><p className="max-w-3xl text-sm text-muted-foreground">Connect only the folders Josi may use on this device. Folder contents stay private until you ask Josi to read them, and every write requires confirmation.</p></header>
    {error?<ErrorNote>{error}</ErrorNote>:null}
    {receipt?<p role="status" className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">Change completed. Receipt: {receipt}</p>:null}

    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(19rem,.9fr)]">
      <Card className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-base font-semibold">Connected folders</h2><p className="mt-1 text-sm text-muted-foreground">Folders on this device, plus storage attached to your Josi server.</p></div>{bridge?<Button disabled={adding} onClick={()=>void chooseFolder(false)}><PlusIcon/>{adding?'Opening…':'Add folder'}</Button>:null}</div>
        {mappings.length?<ul className="space-y-2" aria-label="Connected folders">{mappings.map(mapping=>{const writable=mapping.provider==='desktop'?mapping.writable===true:[mapping.may_create,mapping.may_edit,mapping.may_move,mapping.may_delete].some(Boolean);return <li key={mapping.id}><button type="button" onClick={()=>{setId(mapping.id);setPath('');setEntries([]);}} className={cn('flex min-h-16 w-full items-center gap-3 rounded-lg border p-3 text-left transition-colors','hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',id===mapping.id?'border-primary bg-primary/10':'border-border')}><span className="grid h-10 w-10 shrink-0 place-items-center rounded-md bg-secondary text-primary"><FolderIcon/></span><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{mapping.display_path}</span><span className="mt-1 flex flex-wrap items-center gap-2"><Badge tone={writable?'primary':'ok'}>{writable?'read/write':'read-only'}</Badge><span className="text-xs text-muted-foreground">{mapping.provider==='desktop'?'This device':'Server folder'}</span></span></span><span aria-hidden className="text-muted-foreground">›</span></button></li>;})}</ul>:<Empty title="No folders connected yet">Add a folder from this device. Read-only is the safer default and can be changed later.</Empty>}
      </Card>

      <Card className="space-y-4">
        <div><h2 className="text-base font-semibold">Folder permissions</h2><p className="mt-1 text-sm text-muted-foreground">Choose the smallest level of access Josi needs.</p></div>
        {!bridge?<div className="rounded-lg border border-border bg-secondary/30 p-4 text-sm"><p className="font-medium">Open this page in Josi CE desktop</p><p className="mt-1 text-muted-foreground">A regular browser cannot grant access to folders on this device.</p></div>:<><button type="button" disabled={adding} onClick={()=>void chooseFolder(false)} className="flex min-h-20 w-full items-start gap-3 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-4 text-left hover:bg-emerald-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><ShieldIcon/><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 font-medium">Read only <Badge tone="ok">Recommended</Badge></span><span className="mt-1 block text-sm text-muted-foreground">Josi can list and read safe files, but cannot change anything.</span></span></button><button type="button" disabled={adding} onClick={()=>void chooseFolder(true)} className="flex min-h-20 w-full items-start gap-3 rounded-lg border border-border p-4 text-left hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"><EditShieldIcon/><span className="min-w-0 flex-1"><span className="font-medium">Read and write</span><span className="mt-1 block text-sm text-muted-foreground">Josi can propose changes. Every write still needs your native one-time approval.</span></span></button></>}
        <div className="border-t border-border pt-4"><h3 className="text-sm font-medium">Current selection</h3>{selected?<div className="mt-2 flex items-start gap-3"><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-secondary text-primary"><FolderIcon/></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{selected.display_path}</p><p className="mt-0.5 text-xs text-muted-foreground">{selectedWritable?'Read/write · every change asks first':'Read-only · no changes allowed'}</p></div>{selected.provider==='desktop'&&selectedRoot?<Button variant="ghost" disabled={busy} onClick={()=>void revokeDesktop(selectedRoot.id)}>Revoke</Button>:null}</div>:<p className="mt-2 text-sm text-muted-foreground">Select a connected folder to browse it.</p>}</div>
      </Card>
    </div>

    {selected?<Card className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-base font-semibold">Folder contents</h2><p className="mt-1 text-sm text-muted-foreground">{selected.display_path}</p></div><Button variant="secondary" disabled={busy} onClick={()=>void refresh()}>{busy?'Loading…':'Refresh'}</Button></div>
      <nav aria-label="Workspace breadcrumbs" className="flex min-h-11 flex-wrap items-center gap-1 rounded-md bg-secondary/40 px-3 text-sm"><button className="font-medium text-primary underline-offset-4 hover:underline" onClick={()=>setPath('')}>Folder root</button>{path.split('/').filter(Boolean).map((part,index,all)=><button className="text-primary underline-offset-4 hover:underline" key={`${part}-${index}`} onClick={()=>setPath(all.slice(0,index+1).join('/'))}>/ {part}</button>)}</nav>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]"><label className="text-sm font-medium">Search this folder<Input className="mt-1" value={filter} onChange={event=>setFilter(event.target.value)} placeholder="Filter by name"/></label><label className="text-sm font-medium">Sort<select className="mt-1 min-h-11 w-full rounded-md border border-input bg-background px-3 text-base sm:text-sm" value={sort} onChange={event=>setSort(event.target.value)}><option value="asc">Name A–Z</option><option value="desc">Name Z–A</option></select></label></div>
      {busy?<p role="status" className="text-sm text-muted-foreground">Loading folder…</p>:filteredEntries.length?<ul aria-label="Workspace files" className="divide-y divide-border rounded-lg border border-border">{filteredEntries.map(entry=><li className="flex flex-wrap items-center gap-3 p-3" key={entry.name}><span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-secondary text-primary">{entry.kind==='folder'?<FolderIcon/>:<FileIcon/>}</span><span className="min-w-0 flex-1 break-all">{entry.kind==='folder'?<button className="font-medium text-primary hover:underline" onClick={()=>setPath(full(entry.name))}>{entry.name}</button>:<span className="text-sm font-medium">{entry.name}</span>}{entry.size!==undefined?<small className="mt-0.5 block text-muted-foreground">{formatBytes(entry.size)}{entry.modified?` · ${new Date(entry.modified).toLocaleString()}`:''}</small>:null}</span>{entry.kind==='file'?<div className="flex flex-wrap gap-1"><a className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-primary hover:bg-secondary" href={`/api/workspace/${id}/file?path=${encodeURIComponent(full(entry.name))}`}>Download</a><Button variant="ghost" onClick={()=>{void api.get<{text:string;size:number;modified:string}>(`/workspace/${id}/preview?path=${encodeURIComponent(full(entry.name))}`).then(value=>setPreview(`${value.size} bytes · ${value.modified}\n\n${value.text}`)).catch(e=>setError(e.message));}}>Preview</Button>{permissions.edit?<Button variant="ghost" onClick={()=>{void api.get<{text:string}>(`/workspace/${id}/preview?path=${encodeURIComponent(full(entry.name))}`).then(value=>{setName(entry.name);setContent(value.text);setEditing(true);}).catch(e=>setError(e.message));}}>Edit</Button>:null}{permissions.move?<Button variant="ghost" onClick={()=>{setName(entry.name);setDestination(full(entry.name));}}>Move</Button>:null}{permissions.delete?<Button variant="ghost" onClick={()=>void propose({operation:'delete',path:full(entry.name)})}>Delete</Button>:null}</div>:null}</li>)}</ul>:<Empty title={filter?'No matching items':'This folder is empty'}>{filter?'Try a different filter.':'Files and folders you add here will appear in this list.'}</Empty>}
    </Card>:null}

    {preview?<section aria-label="File preview"><Card><div className="mb-3 flex items-center justify-between gap-3"><h2 className="font-semibold">File preview</h2><Button variant="ghost" onClick={()=>setPreview('')}>Close</Button></div><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary/40 p-3 text-sm">{preview}</pre></Card></section>:null}
    {destination?<form className="space-y-3 rounded-lg border border-border bg-card p-4" onSubmit={event=>{event.preventDefault();void propose({operation:'move',path:full(name),destination});}}><h2 className="font-semibold">Move or rename</h2><label className="block text-sm font-medium">Destination relative to mapped root<Input className="mt-1" value={destination} onChange={event=>setDestination(event.target.value)}/></label><div className="flex gap-2"><Button type="submit">Review move</Button><Button type="button" variant="secondary" onClick={()=>setDestination('')}>Cancel</Button></div></form>:null}
    {selected&&(permissions.create||permissions.edit)?<Card className="space-y-3"><h2 className="font-semibold">Create or upload text</h2><div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium">Filename<Input className="mt-1" value={name} onChange={event=>setName(event.target.value)}/></label><label className="text-sm font-medium">Upload text (256 KiB maximum)<Input className="mt-1 py-2" type="file" accept=".txt,.md,.csv,.json,.log" onChange={event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>262144){setError('File exceeds 256 KiB');return;}setName(file.name);void file.text().then(setContent);}}/></label></div><label className="block text-sm font-medium">Contents<textarea className="mt-1 min-h-40 w-full rounded-md border border-input bg-background p-3 text-base sm:text-sm" value={content} onChange={event=>setContent(event.target.value)}/></label><div className="flex flex-wrap gap-2"><Button onClick={()=>void propose({operation:editing?'edit':'create',path:full(name),content})}>{editing?'Review text edit':'Review file creation'}</Button>{permissions.create?<Button variant="secondary" onClick={()=>void propose({operation:'mkdir',path:full(name)})}>Review folder creation</Button>:null}{editing?<Button variant="ghost" onClick={()=>setEditing(false)}>Create a new file instead</Button>:null}</div></Card>:null}
    {selected?<WorkspaceCode mappingId={id}/>:null}
    {pending?<section role="region" aria-label="Confirm workspace change" className="space-y-3 rounded-lg border border-primary/40 bg-card p-4"><h2 className="font-semibold">Confirm {pending.change.operation}</h2><p className="break-all text-sm">{pending.change.path}{pending.change.destination?` → ${pending.change.destination}`:''}</p>{pending.change.operation==='delete'?<p className="text-sm text-muted-foreground">This removes the file from this folder. A recovery copy is retained for the operator.</p>:null}{pending.change.content!==undefined?<pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded-md bg-secondary/40 p-3 text-sm">{pending.change.content}</pre>:null}<div className="flex gap-2"><Button disabled={busy} onClick={()=>{setBusy(true);void api.post<{receipt:string}>(`/workspace/${id}/change/${pending.id}`,{...pending.change,confirm:true}).then(value=>{setReceipt(value.receipt);setPending(null);setDestination('');return refresh();}).catch(e=>setError(e.message)).finally(()=>setBusy(false));}}>Approve exact change</Button><Button variant="secondary" onClick={()=>setPending(null)}>Cancel</Button></div></section>:null}
    <p className="text-xs text-muted-foreground">Server-mounted folders are managed under <Link className="underline" to="/app/connections">Connections</Link>. Desktop access lasts only while Josi CE is open and signed in.</p>
  </main>;
}

function formatBytes(value:number){if(value<1024)return `${value} bytes`;if(value<1024*1024)return `${(value/1024).toFixed(1)} KiB`;return `${(value/1024/1024).toFixed(1)} MiB`;}
function FolderIcon(){return <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5Z"/></svg>;}
function FileIcon(){return <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4"/></svg>;}
function PlusIcon(){return <svg aria-hidden viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 5v14M5 12h14"/></svg>;}
function ShieldIcon(){return <svg aria-hidden viewBox="0 0 24 24" className="mt-0.5 h-6 w-6 shrink-0 text-emerald-400" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6Z"/><path d="m8.5 12 2.2 2.2 4.8-5"/></svg>;}
function EditShieldIcon(){return <svg aria-hidden viewBox="0 0 24 24" className="mt-0.5 h-6 w-6 shrink-0 text-primary" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3 20 6v5c0 5-3.4 8.3-8 10-4.6-1.7-8-5-8-10V6Z"/><path d="m9 14 5.4-5.4 1 1L10 15H9Z"/></svg>;}
