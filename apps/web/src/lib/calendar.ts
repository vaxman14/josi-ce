export type CalendarView = 'list' | 'month' | 'week' | 'day';
export interface CalendarEvent { start: string | null; end: string | null; allDay: boolean }
export function dayKey(date: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (name: string) => parts.find(p => p.type === name)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
export function addDays(day: string, count: number): string {
  const date = new Date(`${day}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + count); return date.toISOString().slice(0, 10);
}
/** Resolve a civil midnight independently at each boundary (DST days are not 24 hours). */
export function midnight(day: string, zone: string): Date {
  const target = Date.parse(`${day}T00:00:00Z`); let value = target;
  for (let i = 0; i < 4; i++) {
    const p = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(new Date(value));
    const n = (type:string) => Number(p.find(x=>x.type===type)!.value);
    const civil = Date.UTC(n('year'), n('month')-1, n('day'), n('hour'), n('minute'), n('second'));
    const next = value + target - civil; if (next === value) break; value = next;
  }
  return new Date(value);
}
export function calendarRange(anchor: string, view: CalendarView, zone: string) {
  let first = anchor; let count = view === 'day' ? 1 : 7;
  if (view === 'week') first = addDays(anchor, -new Date(`${anchor}T12:00:00Z`).getUTCDay());
  if (view === 'month') { first = `${anchor.slice(0,7)}-01`; first = addDays(first, -new Date(`${first}T12:00:00Z`).getUTCDay()); count = 42; }
  const days = Array.from({length: count}, (_, i)=>addDays(first,i));
  return { days, start: midnight(first,zone).toISOString(), end: midnight(addDays(first,count),zone).toISOString() };
}
export function moveCalendar(anchor:string, view:CalendarView, direction:number) {
  if (view !== 'month') return addDays(anchor, direction * (view === 'day' ? 1 : 7));
  const date = new Date(`${anchor.slice(0,7)}-01T12:00:00Z`); date.setUTCMonth(date.getUTCMonth()+direction); return date.toISOString().slice(0,10);
}
export function eventsOnDay<T extends CalendarEvent>(events:T[], day:string, zone:string):T[] {
  const start=midnight(day,zone).getTime(), end=midnight(addDays(day,1),zone).getTime();
  return events.filter(e=>e.start && (e.allDay ? e.start.slice(0,10)<=day && (e.end?.slice(0,10) ?? addDays(e.start.slice(0,10),1))>day : Date.parse(e.start)<end && Math.max(Date.parse(e.end ?? e.start),Date.parse(e.start)+1)>start));
}
/** Interval partitioning; each connected overlap group shares the same column count. */
export function layoutEvents<T extends CalendarEvent>(events:T[], day:string, zone:string) {
  const start=midnight(day,zone).getTime(), end=midnight(addDays(day,1),zone).getTime();
  const rows=events.filter(e=>!e.allDay && e.start).map(event=>({event, start:Math.max(start,Date.parse(event.start!)), end:Math.min(end,Math.max(Date.parse(event.end ?? event.start! ),Date.parse(event.start!)+15*60000)), column:0, columns:1})).sort((a,b)=>a.start-b.start);
  let group:typeof rows=[]; let ends:number[]=[];
  const finish=()=>{for(const row of group) row.columns=ends.length;group=[];ends=[];};
  for(const row of rows){ if(ends.length && ends.every(t=>t<=row.start)) finish(); let column=ends.findIndex(t=>t<=row.start); if(column<0) column=ends.length; row.column=column;ends[column]=row.end;group.push(row); } finish();
  return rows.map(row=>({...row,top:(row.start-start)/(end-start)*100,height:(row.end-row.start)/(end-start)*100}));
}
