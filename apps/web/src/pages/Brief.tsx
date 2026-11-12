// Daily brief: when Josi writes to you on her own, what she remembers, and
// what she is working on. Everything here is the signed-in person's own.
//
// - Settings: brief on or off, check-ins on or off, quiet hours. Off until you
//   turn it on, because a brief reads your inbox and calendar (only what you
//   have allowed Josi to read).
// - Tasks: Josi moves a task between working, waiting on you and blocked and
//   may say she thinks it is done; only you mark it done.
// - Memory: the short notes file Josi keeps about you, sealed in your Vault.
//   You can read every line, change it, add one or delete it.
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface Settings { briefEnabled: boolean; checkinsEnabled: boolean; quietStart: string; quietEnd: string; timezone: string | null; workspaceTimezone: string }
interface Task { id: string; title: string; state: 'working' | 'waiting_on_user' | 'blocked' | 'done'; detail: string | null; doneProposed: boolean }
interface Line { id: string; text: string; date: string }
interface Section { section: string; label: string; lines: Line[] }

const STATE_LABEL: Record<Task['state'], string> = { working: 'Working on it', waiting_on_user: 'Waiting on you', blocked: 'Blocked', done: 'Done' };
const message = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback;

function Switch({ label, help, on, disabled, onChange }: { label: string; help: string; on: boolean; disabled: boolean; onChange: (value: boolean) => void }) {
  return <label className="flex min-h-11 items-start gap-3 text-sm">
    <input type="checkbox" className="mt-1 h-5 w-5" checked={on} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    <span><span className="font-medium">{label}</span><span className="block text-muted-foreground">{help}</span></span>
  </label>;
}

function SettingsCard() {
  const [settings, setSettings] = useState<Settings>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => { api.get<Settings>('/brief/settings').then(setSettings).catch(e => setError(message(e, 'Could not load your settings'))); }, []);
  async function save(patch: Partial<Settings>) {
    setBusy(true); setError('');
    try { const next = await api.put<Settings>('/brief/settings', patch); setSettings(prev => ({ ...(prev as Settings), ...next })); }
    catch (e) { setError(message(e, 'Could not save')); }
    finally { setBusy(false); }
  }
  async function briefNow() {
    setBusy(true); setError(''); setSent(false);
    try { await api.post('/brief/run', {}); setSent(true); } catch (e) { setError(message(e, 'Could not start a brief')); } finally { setBusy(false); }
  }
  if (!settings) return error ? <ErrorNote>{error}</ErrorNote> : null;
  return <Card>
    <CardTitle>Josi writes to you</CardTitle>
    <p className="mt-1 text-sm text-muted-foreground">Josi can start the day with a short brief and check in up to twice a day. She only reads what you have allowed her to read, and she only suggests: anything that sends, pays, deletes or books waits for your yes.</p>
    {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    <div className="mt-3 grid gap-2">
      <Switch label="Morning brief" help="When your quiet hours end, once a day." on={settings.briefEnabled} disabled={busy} onChange={value => void save({ briefEnabled: value })} />
      <Switch label="Check-ins" help="Up to two a day outside quiet hours. She posts only if something changed, needs you, or is time-sensitive." on={settings.checkinsEnabled} disabled={busy} onChange={value => void save({ checkinsEnabled: value })} />
    </div>
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <label className="grid gap-1 text-sm">Quiet hours start<Input type="time" value={settings.quietStart} disabled={busy} onChange={e => e.target.value && void save({ quietStart: e.target.value })} /></label>
      <label className="grid gap-1 text-sm">Quiet hours end<Input type="time" value={settings.quietEnd} disabled={busy} onChange={e => e.target.value && void save({ quietEnd: e.target.value })} /></label>
    </div>
    <p className="mt-2 text-xs text-muted-foreground">Time zone: {settings.timezone ?? settings.workspaceTimezone}</p>
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Button variant="secondary" disabled={busy} onClick={() => void briefNow()}>Send me a brief now</Button>
      {sent ? <Badge tone="ok">On its way: it appears in the Daily brief conversation</Badge> : null}
    </div>
  </Card>;
}

function TasksCard() {
  const [tasks, setTasks] = useState<Task[]>();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get<{ tasks: Task[] }>('/brief/tasks').then(r => setTasks(r.tasks)).catch(e => setError(message(e, 'Could not load your tasks'))), []);
  useEffect(() => { void load(); }, [load]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); await load(); } catch (e) { setError(message(e, 'That did not work')); } finally { setBusy(false); }
  }
  return <Card>
    <CardTitle>What Josi is working on</CardTitle>
    {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    {tasks && !tasks.length ? <p className="mt-2 text-sm text-muted-foreground">Nothing open. Ask Josi to take something on, or add it here.</p> : null}
    <ul className="mt-2 grid gap-2">
      {(tasks ?? []).map(task => <li key={task.id} className="rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{task.title}</span>
          <Badge tone={task.state === 'waiting_on_user' ? 'primary' : task.state === 'blocked' ? 'danger' : 'muted'}>{STATE_LABEL[task.state]}</Badge>
          {task.doneProposed ? <Badge tone="ok">Josi thinks it is done</Badge> : null}
        </div>
        {task.detail ? <p className="mt-1 text-sm text-muted-foreground">{task.detail}</p> : null}
        <div className="mt-2 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={() => void run(() => api.put(`/brief/tasks/${task.id}`, { state: 'done' }))}>Mark done</Button>
          <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.del(`/brief/tasks/${task.id}`))}>Remove</Button>
        </div>
      </li>)}
    </ul>
    <form className="mt-3 flex gap-2" onSubmit={e => { e.preventDefault(); if (title.trim()) void run(async () => { await api.post('/brief/tasks', { title }); setTitle(''); }); }}>
      <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Add a task for Josi" maxLength={300} aria-label="New task" />
      <Button type="submit" disabled={busy || !title.trim()}>Add</Button>
    </form>
  </Card>;
}

function MemoryCard() {
  const [sections, setSections] = useState<Section[]>();
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [adding, setAdding] = useState<{ section: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(() => api.get<{ sections: Section[] }>('/brief/notes').then(r => setSections(r.sections)).catch(e => setError(message(e, 'Could not open your notes'))), []);
  useEffect(() => { void load(); }, [load]);
  async function run(work: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await work(); setEditing(null); setAdding(null); await load(); } catch (e) { setError(message(e, 'That did not work')); } finally { setBusy(false); }
  }
  return <Card>
    <CardTitle>What Josi remembers</CardTitle>
    <p className="mt-1 text-sm text-muted-foreground">A short notes file, sealed in your Vault. Josi adds a line when she learns something lasting, and keeps it short and dated. Read, change or delete any line.</p>
    {error ? <div className="mt-3"><ErrorNote>{error}</ErrorNote></div> : null}
    {(sections ?? []).map(section => <section key={section.section} className="mt-4" aria-label={section.label}>
      <h3 className="font-display text-sm font-semibold">{section.label}</h3>
      {!section.lines.length ? <p className="text-sm text-muted-foreground">Nothing yet.</p> : null}
      <ul className="mt-1 grid gap-1">
        {section.lines.map(line => <li key={line.id} className="flex flex-wrap items-center gap-2 text-sm">
          {editing?.id === line.id
            ? <form className="flex w-full gap-2" onSubmit={e => { e.preventDefault(); void run(() => api.put(`/brief/notes/${line.id}`, { text: editing.text })); }}>
                <Input value={editing.text} onChange={e => setEditing({ id: line.id, text: e.target.value })} maxLength={240} aria-label="Edit note" />
                <Button type="submit" disabled={busy || !editing.text.trim()}>Save</Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              </form>
            : <>
                <span className="min-w-0 flex-1 break-words">{line.text} <span className="text-xs text-muted-foreground">{line.date}</span></span>
                <Button variant="ghost" disabled={busy} onClick={() => setEditing({ id: line.id, text: line.text })}>Edit</Button>
                <Button variant="ghost" disabled={busy} onClick={() => void run(() => api.del(`/brief/notes/${line.id}`))}>Delete</Button>
              </>}
        </li>)}
      </ul>
      {adding?.section === section.section
        ? <form className="mt-1 flex gap-2" onSubmit={e => { e.preventDefault(); void run(() => api.post('/brief/notes', { section: section.section, text: adding.text })); }}>
            <Input value={adding.text} onChange={e => setAdding({ section: section.section, text: e.target.value })} maxLength={240} placeholder="One short line" aria-label={`Add to ${section.label}`} />
            <Button type="submit" disabled={busy || !adding.text.trim()}>Add</Button>
            <Button type="button" variant="ghost" onClick={() => setAdding(null)}>Cancel</Button>
          </form>
        : <Button variant="ghost" onClick={() => setAdding({ section: section.section, text: '' })}>Add a line</Button>}
    </section>)}
  </Card>;
}

export function Brief() {
  return <div className="mx-auto grid max-w-3xl gap-4 p-4">
    <h1 className="font-display text-2xl font-semibold">Daily brief</h1>
    <SettingsCard />
    <TasksCard />
    <MemoryCard />
  </div>;
}
