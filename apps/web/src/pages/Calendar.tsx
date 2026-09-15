import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';

type View = 'day' | 'week' | 'month';
interface Source { id:string; name:string; color:string|null; provider:'google'|'microsoft'; account:string|null; selected:boolean; primary:boolean; writable:boolean }
interface EventRow { eventId:string; sourceId:string; sourceName:string; sourceColor:string|null; provider:string; account:string|null; title:string|null; start:string|null; end:string|null; allDay:boolean; location:string|null; organizer:string|null; attendees:string[]; status:string|null }

const DAY=86_400_000;
function range(anchor:string, view:View) {
  const base=new Date(`${anchor}T00:00:00`); const start=new Date(base); const end=new Date(base);
  if(view==='week'){ start.setDate(start.getDate()-start.getDay()); end.setTime(start.getTime()+7*DAY); }
  else if(view==='month'){ start.setDate(1); end.setMonth(start.getMonth()+1,1); }
  else end.setTime(start.getTime()+DAY);
  return {start:start.toISOString(),end:end.toISOString()};
}
const dateValue=(date=new Date())=>date.toISOString().slice(0,10);

export function Calendar() {
  const [sources,setSources]=useState<Source[]>([]); const [events,setEvents]=useState<EventRow[]>([]);
  const [anchor,setAnchor]=useState(dateValue()); const [view,setView]=useState<View>('week');
  const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [detail,setDetail]=useState<any>(null);
  const [warnings,setWarnings]=useState<string[]>([]);
  const window=useMemo(()=>range(anchor,view),[anchor,view]);
  const loadSources=useCallback(async(refresh=false)=>{ const r=await api.get<{sources:Source[];discoveryErrors?:Array<{error:string}>}>(`/calendar/sources${refresh?'?refresh=true':''}`); setSources(r.sources); setWarnings(r.discoveryErrors?.map(e=>e.error)??[]); },[]);
  const loadEvents=useCallback(async()=>{ const q=new URLSearchParams(window); const r=await api.get<{events:EventRow[];sourceErrors?:Array<{error:string}>}>(`/calendar/events?${q}`); setEvents(r.events); setWarnings(old=>[...old,...(r.sourceErrors?.map(e=>e.error)??[])]); },[window]);
  useEffect(()=>{ setLoading(true); setError(''); void Promise.all([loadSources(),loadEvents()]).catch(e=>setError(e instanceof Error?e.message:'Could not load calendars')).finally(()=>setLoading(false)); },[loadSources,loadEvents]);
  async function select(source:Source){ setSources(rows=>rows.map(r=>r.id===source.id?{...r,selected:!r.selected}:r)); try{await api.put(`/calendar/sources/${source.id}`,{selected:!source.selected});await loadEvents();}catch(e){setError(e instanceof Error?e.message:'Could not change that calendar');await loadSources();}}
  async function inspect(event:EventRow){ try{const r=await api.get<{event:any}>(`/calendar/events/${event.sourceId}/${encodeURIComponent(event.eventId)}`);setDetail({...r.event,sourceName:event.sourceName});}catch(e){setError(e instanceof Error?e.message:'Could not load that event');}}
  function move(direction:number){const d=new Date(`${anchor}T12:00:00`);d.setDate(d.getDate()+direction*(view==='day'?1:view==='week'?7:30));setAnchor(dateValue(d));}
  return <div className="mx-auto w-full max-w-5xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Calendar</h1><p className="text-sm text-muted-foreground">One view of the calendars you choose from all your connected accounts.</p></div><Button variant="secondary" onClick={()=>void loadSources(true).then(loadEvents).catch(e=>setError(String(e)))}>Refresh calendars</Button></div>
    {error?<ErrorNote>{error}</ErrorNote>:null}
    {warnings.length?<ErrorNote>{[...new Set(warnings)].join(' ')}</ErrorNote>:null}
    <Card><CardTitle>Calendars</CardTitle>{sources.length?<div className="mt-3 grid gap-2 sm:grid-cols-2">{sources.map(s=><label key={s.id} className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3"><input type="checkbox" checked={s.selected} onChange={()=>void select(s)}/><span className="h-3 w-3 rounded-full" style={{backgroundColor:s.color||'#f97316'}}/><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{s.name}</span><span className="block truncate text-xs text-muted-foreground">{s.account||s.provider}</span></span>{s.primary?<Badge>Primary</Badge>:null}</label>)}</div>:<p className="mt-2 text-sm text-muted-foreground">No enabled calendar connection yet. Connect Google or Microsoft and turn on calendar reading.</p>}</Card>
    <Card><div className="flex flex-wrap items-center gap-2"><Button variant="secondary" onClick={()=>move(-1)}>Previous</Button><input aria-label="Calendar date" className="h-11 rounded-md border border-border bg-background px-3" type="date" value={anchor} onChange={e=>setAnchor(e.target.value)}/><Button variant="secondary" onClick={()=>move(1)}>Next</Button><div className="sm:ml-auto">{(['day','week','month'] as View[]).map(v=><Button key={v} variant={view===v?'primary':'secondary'} className="ml-1 capitalize" onClick={()=>setView(v)}>{v}</Button>)}</div></div>
      <div className="mt-4 space-y-2" aria-busy={loading}>{loading?<p className="text-sm text-muted-foreground">Loading…</p>:events.length?events.map(e=><button type="button" key={`${e.sourceId}:${e.eventId}`} onClick={()=>void inspect(e)} className="flex min-h-14 w-full items-center gap-3 rounded-md border border-border p-3 text-left hover:bg-secondary/50"><span className="h-8 w-1 rounded" style={{backgroundColor:e.sourceColor||'#f97316'}}/><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{e.title||'Untitled event'}</span><span className="block text-xs text-muted-foreground">{e.allDay?'All day':e.start?new Date(e.start).toLocaleString():''} · {e.sourceName}</span></span></button>):<p className="text-sm text-muted-foreground">No events in this range.</p>}</div>
    </Card>
    {detail?<Card><div className="flex justify-between gap-2"><CardTitle>{detail.title||'Untitled event'}</CardTitle><Button variant="secondary" onClick={()=>setDetail(null)}>Close</Button></div><dl className="mt-3 space-y-2 text-sm"><div><dt className="text-muted-foreground">Calendar</dt><dd>{detail.sourceName}</dd></div><div><dt className="text-muted-foreground">When</dt><dd>{detail.start||'Unknown'} — {detail.end||'Unknown'}</dd></div>{detail.location?<div><dt className="text-muted-foreground">Location</dt><dd>{detail.location}</dd></div>:null}{detail.description?<div><dt className="text-muted-foreground">Details</dt><dd className="whitespace-pre-wrap">{detail.description}</dd></div>:null}</dl></Card>:null}
  </div>;
}
