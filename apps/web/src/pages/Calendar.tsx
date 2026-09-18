import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { midnight, addDays, calendarRange, dayKey, eventsOnDay, layoutEvents, moveCalendar, type CalendarView } from '@/lib/calendar';
import { api } from '@/lib/api';
import { plain } from '@/lib/plainLanguage';
import { Badge, Button, Card, CardTitle, ErrorNote } from '@/components/ui';

type View = CalendarView;
interface Source { id:string; connectionId:string; name:string; color:string|null; provider:'google'|'microsoft'; account:string|null; selected:boolean; primary:boolean; writable:boolean; writeDefault:boolean }
interface EventRow { eventId:string; connectionId:string; sourceId:string; sourceName:string; sourceColor:string|null; provider:string; account:string|null; title:string|null; start:string|null; end:string|null; allDay:boolean; location:string|null; organizer:string|null; attendees:string[]; status:string|null }

export function Calendar() {
  const [sources,setSources]=useState<Source[]>([]); const [events,setEvents]=useState<EventRow[]>([]);
  const [anchor,setAnchor]=useState(dayKey(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone)); const [view,setView]=useState<View>('week');
  const [loading,setLoading]=useState(true); const [error,setError]=useState(''); const [detail,setDetail]=useState<any>(null);
  const detailRef=useRef<HTMLElement>(null); const lastEventButton=useRef<HTMLButtonElement|null>(null);
  useEffect(()=>{if(detail)detailRef.current?.focus();},[detail]);
  const [warnings,setWarnings]=useState<string[]>([]);
  const [zone,setZone]=useState(Intl.DateTimeFormat().resolvedOptions().timeZone);
  const window=useMemo(()=>calendarRange(anchor,view,zone),[anchor,view,zone]);
  const loadSources=useCallback(async(refresh=false)=>{ const r=await api.get<{sources:Source[];discoveryErrors?:Array<{error:string}>}>(`/calendar/sources${refresh?'?refresh=true':''}`); setSources(r.sources); setWarnings(r.discoveryErrors?.map(e=>e.error)??[]); },[]);
  const generation=useRef(0);
  const loadEvents=useCallback(async()=>{
    const request=++generation.current; setLoading(true); setEvents([]);
    try {
      const q=new URLSearchParams({start:window.start,end:window.end});
      const r=await api.get<{events:EventRow[];sourceErrors?:Array<{error:string}>}>(`/calendar/events?${q}`);
      if(request!==generation.current)return;
      setEvents(r.events); setWarnings(old=>[...old,...(r.sourceErrors?.map(e=>e.error)??[])]);
    } finally { if(request===generation.current)setLoading(false); }
  },[window]);
  useEffect(()=>{
    let active=true;setLoading(true);setError('');
    void loadSources().then(()=>active?loadEvents():undefined).catch(e=>{if(active){setError(e instanceof Error?e.message:'Could not load calendars');setLoading(false);}});
    return ()=>{active=false;generation.current++;};
  },[loadSources,loadEvents]);
  async function select(source:Source){ setSources(rows=>rows.map(r=>r.id===source.id?{...r,selected:!r.selected}:r)); try{await api.put(`/calendar/sources/${source.id}`,{selected:!source.selected});await loadEvents();}catch(e){setError(e instanceof Error?e.message:'Could not change that calendar');await loadSources();}}
  async function makeWriteDefault(source:Source){ try{await api.put(`/calendar/sources/${source.id}`,{writeDefault:true});await loadSources();}catch(e){setError(e instanceof Error?e.message:'Could not set the default calendar');await loadSources();}}
  async function inspect(event:EventRow){ try{const r=await api.get<{event:any}>(`/calendar/events/${event.sourceId}/${encodeURIComponent(event.eventId)}`);setDetail({...r.event,sourceName:event.sourceName,account:event.account,provider:event.provider,connectionId:event.connectionId});}catch(e){setError(e instanceof Error?e.message:'Could not load that event');}}
  function move(direction:number){setAnchor(moveCalendar(anchor,view,direction));}
  const eventButton=(e:EventRow, compact=false)=><button type="button" key={`${e.sourceId}:${e.eventId}`} onClick={click=>{lastEventButton.current=click.currentTarget;void inspect(e);}} className={`w-full rounded border border-border bg-background p-2 text-left hover:bg-secondary focus-visible:ring-2 focus-visible:ring-primary ${compact?'text-xs':'text-sm'}`} style={{borderLeftWidth:4,borderLeftColor:e.sourceColor||'#f97316'}}><span className="block font-medium">{e.title||'Untitled event'}</span><span className="block">{e.allDay?'All day':e.start?new Date(e.start).toLocaleTimeString([], {timeZone:zone,hour:'numeric',minute:'2-digit',timeZoneName:'short'}):'Unknown time'}</span><span className="block text-muted-foreground">{e.sourceName} · {plain('calendar_provider', e.provider)} · {e.account||e.connectionId}</span></button>;
  function gridKey(event:React.KeyboardEvent<HTMLDivElement>){
    const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-day]')); const index=buttons.indexOf(event.target as HTMLButtonElement);
    const delta:Record<string,number>={ArrowRight:1,ArrowLeft:-1,ArrowDown:7,ArrowUp:-7,Home:-index,End:buttons.length-1-index};
    if(index>=0 && event.key in delta){event.preventDefault();buttons[Math.max(0,Math.min(buttons.length-1,index+delta[event.key]))]?.focus();}
  }
  return <div className="mx-auto w-full max-w-5xl space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-xl font-semibold">Calendar</h1><p className="text-sm text-muted-foreground">One view of the calendars you choose from all your connected accounts.</p></div><Button variant="secondary" onClick={()=>void loadSources(true).then(loadEvents).catch(e=>setError(String(e)))}>Refresh calendars</Button></div>
    {error?<ErrorNote>{error}</ErrorNote>:null}
    {warnings.length?<ErrorNote>{[...new Set(warnings)].join(' ')}</ErrorNote>:null}
    <Card><CardTitle>Calendars</CardTitle>{sources.length?<div className="mt-3 grid gap-2 sm:grid-cols-2">{sources.map(s=><div key={s.id} className="flex min-h-11 items-center gap-3 rounded-md border border-border px-3"><label className="flex min-w-0 flex-1 items-center gap-3"><input type="checkbox" checked={s.selected} onChange={()=>void select(s)}/><span className="h-3 w-3 rounded-full" style={{backgroundColor:s.color||'#f97316'}}/><span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{s.name}</span><span className="block truncate text-xs text-muted-foreground">{plain('calendar_provider', s.provider)} · {s.account||s.connectionId}</span></span></label>{s.primary?<Badge>Primary</Badge>:null}{s.writable?<button type="button" className="rounded px-2 py-1 text-xs underline-offset-2 hover:underline" aria-pressed={s.writeDefault} onClick={()=>void makeWriteDefault(s)}>{s.writeDefault?'Write default':'Make default'}</button>:null}</div>)}</div>:<p className="mt-2 text-sm text-muted-foreground">No enabled calendar connection yet. Connect Google or Microsoft and turn on calendar reading.</p>}</Card>
    <Card><div className="flex flex-wrap items-center gap-2"><Button variant="secondary" onClick={()=>move(-1)}>Previous</Button><input aria-label="Calendar date" className="h-11 rounded-md border border-border bg-background px-3" type="date" value={anchor} onChange={e=>{if(e.target.value)setAnchor(e.target.value);}}/><Button variant="secondary" onClick={()=>move(1)}>Next</Button><Button variant="secondary" onClick={()=>setAnchor(dayKey(new Date(),zone))}>Today</Button><div className="sm:ml-auto">{(['list','month','week','day'] as View[]).map(v=><Button key={v} aria-pressed={view===v} variant={view===v?'primary':'secondary'} className="ml-1 capitalize" onClick={()=>setView(v)}>{v}</Button>)}</div></div>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">Timezone<select aria-label="Calendar timezone" className="max-w-full rounded border border-border bg-background p-2" value={zone} onChange={e=>setZone(e.target.value)}>{[...new Set([zone,'UTC',...Intl.supportedValuesOf('timeZone')])].map(z=><option key={z}>{z}</option>)}</select></label>
      <div className="mt-4" aria-busy={loading} aria-label={`${view} calendar`}>
        {loading?<p role="status">Loading…</p>:<>
          {!events.length?<p role="status" className="mb-3 text-muted-foreground">No events in this range.</p>:null}
          {view==='list'?<div className="space-y-4">{window.days.map(day=>{const rows=eventsOnDay(events,day,zone);return rows.length?<section key={day}><h2 className="mb-2 font-semibold">{day}</h2><div className="space-y-2">{rows.map(e=>eventButton(e))}</div></section>:null;})}</div>:view==='month'?<div className="overflow-x-auto"><div className="grid min-w-[560px] grid-cols-7" onKeyDown={gridKey} aria-label="Month dates">{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(label=><div key={label} className="border border-border p-2 text-sm font-semibold">{label}</div>)}{window.days.map(day=><section key={day} className={`min-h-28 border border-border p-1 ${day.slice(0,7)!==anchor.slice(0,7)?'bg-secondary/30':''}`}><button data-day type="button" className="mb-1 min-h-9 w-full rounded text-left font-medium focus-visible:ring-2 focus-visible:ring-primary" aria-label={`Open ${day}`} aria-current={dayKey(new Date(),zone)===day?'date':undefined} onClick={()=>{setAnchor(day);setView('day');}}>{day.slice(8)} {dayKey(new Date(),zone)===day?'· Today':''}</button><div className="space-y-1">{eventsOnDay(events,day,zone).map(e=>eventButton(e,true))}</div></section>)}</div></div>:<div className="overflow-x-auto"><div className="flex" style={{minWidth:view==='week'?980:280}}>{window.days.map(day=>{const rows=eventsOnDay(events,day,zone);return <section key={day} className="min-w-0 flex-1 border border-border"><h2 className="p-2 text-sm font-semibold">{day}</h2><div className="min-h-12 space-y-1 border-b border-border p-1" aria-label={`All-day events ${day}`}>{rows.filter(e=>e.allDay).map(e=>eventButton(e,true))}</div><div className="relative h-[1200px]" aria-label={`Timed events ${day}`}>{Array.from({length:(midnight(addDays(day,1),zone).getTime()-midnight(day,zone).getTime())/3600000},(_,hour)=><div key={hour} className="absolute w-full border-t border-border text-[10px] text-muted-foreground" style={{top:`${hour*3600000/(midnight(addDays(day,1),zone).getTime()-midnight(day,zone).getTime())*100}%`}}>{new Date(midnight(day,zone).getTime()+3600000*hour).toLocaleTimeString([], {timeZone:zone,hour:'2-digit',minute:'2-digit',timeZoneName:'short'})}</div>)}{layoutEvents(rows,day,zone).map(row=><div key={`${row.event.sourceId}:${row.event.eventId}`} className="absolute overflow-auto p-px" style={{top:`${row.top}%`,height:`${row.height}%`,left:`${row.column/row.columns*100}%`,width:`${100/row.columns}%`}}>{eventButton(row.event,true)}</div>)}</div></section>;})}</div></div>}
        </>}
      </div>
    </Card>
    {detail?<section ref={detailRef} tabIndex={-1} aria-label="Event details"><Card><div className="flex justify-between gap-2"><CardTitle>{detail.title||'Untitled event'}</CardTitle><Button variant="secondary" onClick={()=>{setDetail(null);lastEventButton.current?.focus();}}>Close</Button></div><dl className="mt-3 space-y-2 text-sm"><div><dt className="text-muted-foreground">Calendar</dt><dd>{detail.sourceName} · {plain('calendar_provider', detail.provider)} · {detail.account||detail.connectionId}</dd></div><div><dt className="text-muted-foreground">When</dt><dd>{detail.start||'Unknown'} — {detail.end||'Unknown'}</dd></div>{detail.location?<div><dt className="text-muted-foreground">Location</dt><dd>{detail.location}</dd></div>:null}{detail.description?<div><dt className="text-muted-foreground">Details</dt><dd className="whitespace-pre-wrap">{detail.description}</dd></div>:null}</dl></Card></section>:null}
  </div>;
}
