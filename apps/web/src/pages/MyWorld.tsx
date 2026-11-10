// My World (docs/JOSI_IS_THE_INTERFACE.md rule 8; Windows: apps/windows-native/src/MyWorld.cs).
//
// The person's own records, built entirely from the `kinds` the server sends:
// people, addresses, vehicles, homes, IDs, cards, accounts. Josi fills it in
// from conversation; this page is the fallback to look, correct and remove.
// Secret fields are typed into a protected box here and never pass through
// Josi. Showing one needs the five-minute Vault unlock (POST /vault/unlock)
// and puts the value on this screen only.
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';

interface Spec { kind: string; label: string; plural: string; fields: Array<{ key: string; label: string; secret: boolean; hint?: string }>; dates: Array<{ key: string; label: string }> }
interface Item { id: string; kind: string; label: string; fields: Record<string, string>; dates: Record<string, string>; secretKeys: string[]; secretsSet: string[]; createdAt: string; updatedAt: string }
interface Line { id: string; itemId: string | null; content: string; source: string; createdAt: string }
interface World { kinds: Spec[]; items: Item[]; memory: Line[]; unlocked: boolean }

const selectClass = 'min-h-11 w-full rounded-md border border-border bg-background px-3 text-base sm:text-sm';
const message = (e: unknown, fallback: string) => e instanceof Error && e.message ? e.message : fallback;
const day = (value: string) => { const at = new Date(value); return Number.isNaN(at.getTime()) ? value : at.toLocaleDateString(); };

/** The facts and dates form, for Add and for edit. Secret fields never appear
 * here: they have their own protected box. */
function FactsForm({ spec, secretKeys, initial, submitLabel, busy, onSubmit, onCancel }: {
  spec: Spec; secretKeys: string[]; initial?: Item; submitLabel: string; busy: boolean;
  onSubmit: (body: { label: string; fields: Record<string, string>; dates: Record<string, string> }) => Promise<void>; onCancel: () => void;
}) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [fields, setFields] = useState<Record<string, string>>(initial?.fields ?? {});
  const [dates, setDates] = useState<Record<string, string>>(initial?.dates ?? {});
  const plain = spec.fields.filter(field => !secretKeys.includes(field.key));
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => {
      event.preventDefault();
      // An emptied field is sent as '' so the server removes it.
      const allFields: Record<string, string> = {}; for (const field of plain) allFields[field.key] = (fields[field.key] ?? '').trim();
      const allDates: Record<string, string> = {}; for (const date of spec.dates) allDates[date.key] = (dates[date.key] ?? '').trim();
      void onSubmit({ label: label.trim(), fields: allFields, dates: allDates });
    }}>
      <label className="text-sm sm:col-span-2">Name<Input className="mt-1" value={label} onChange={e => setLabel(e.target.value)} required maxLength={200} placeholder={spec.kind === 'person' ? 'Dana' : spec.kind === 'vehicle' ? '2026 Ford Explorer' : ''} /></label>
      {plain.map(field => (
        <label key={field.key} className="text-sm">{field.label}
          <Input className="mt-1" value={fields[field.key] ?? ''} placeholder={field.hint ?? ''} onChange={e => setFields(v => ({ ...v, [field.key]: e.target.value }))} maxLength={300} />
        </label>
      ))}
      {spec.dates.map(date => (
        <label key={date.key} className="text-sm">{date.label}
          <Input className="mt-1" type="date" value={dates[date.key] ?? ''} onChange={e => setDates(v => ({ ...v, [date.key]: e.target.value }))} />
        </label>
      ))}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" disabled={busy || !label.trim()}>{submitLabel}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

function SecretRow({ item, fieldKey, fieldLabel, unlocked, busy, act, onNeedUnlock }: {
  item: Item; fieldKey: string; fieldLabel: string; unlocked: boolean; busy: boolean;
  act: (work: () => Promise<unknown>, note?: string) => Promise<boolean>; onNeedUnlock: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [shown, setShown] = useState<string | null>(null);
  const hide = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(hide.current), []);
  // Locking again (the five minutes ran out) hides what is on screen.
  useEffect(() => { if (!unlocked) setShown(null); }, [unlocked]);
  const isSet = item.secretsSet.includes(fieldKey);
  const path = `/my-world/items/${item.id}/secrets/${encodeURIComponent(fieldKey)}`;
  return (
    <li className="rounded-md border border-border p-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm"><span className="font-medium">{fieldLabel}</span> <span className="text-xs text-muted-foreground">{isSet ? 'set' : 'not set'} · secret</span></span>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setEditing(v => !v); setValue(''); }}>{isSet ? 'Replace…' : 'Set…'}</Button>
        {isSet ? shown === null
          ? <Button type="button" variant="secondary" disabled={busy} onClick={() => {
            if (!unlocked) { onNeedUnlock(); return; }
            void act(async () => {
              const result = await api.post<{ value: string; screenOnly: boolean }>(`${path}/reveal`, {});
              setShown(result.value);
              window.clearTimeout(hide.current);
              hide.current = window.setTimeout(() => setShown(null), 60_000);
            });
          }}>Show</Button>
          : <Button type="button" variant="secondary" onClick={() => setShown(null)}>Hide</Button> : null}
        {isSet ? <Button type="button" variant="danger" disabled={busy} onClick={() => {
          if (!window.confirm(`Clear ${fieldLabel}? The saved value is removed from your World.`)) return;
          setShown(null);
          void act(() => api.del(path), `Cleared ${fieldLabel}.`);
        }}>Clear</Button> : null}
      </div>
      {shown !== null ? <p className="mt-2 select-all break-all rounded bg-secondary px-2 py-1 font-mono text-sm" aria-label={`${fieldLabel}, shown on this screen only`}>{shown}</p> : null}
      {editing ? <form className="mt-2 flex flex-wrap items-end gap-2" autoComplete="off" onSubmit={event => {
        event.preventDefault();
        const secret = value; setValue('');
        void act(() => api.put(path, { value: secret }), `Saved ${fieldLabel}.`).then(ok => { if (ok) setEditing(false); });
      }}>
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">{fieldLabel} for {item.label}
          <Input type="password" autoComplete="new-password" value={value} onChange={e => setValue(e.target.value)} required disabled={busy} /></label>
        <Button type="submit" disabled={busy || !value}>Save</Button>
        <p className="w-full text-xs text-muted-foreground">Typed here, sealed into your World. Josi never sees it, and it is shown again only on this page behind your password.</p>
      </form> : null}
    </li>
  );
}

function ItemCard({ item, spec, unlocked, busy, act, onNeedUnlock }: {
  item: Item; spec: Spec | undefined; unlocked: boolean; busy: boolean;
  act: (work: () => Promise<unknown>, note?: string) => Promise<boolean>; onNeedUnlock: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [sensitivity, setSensitivity] = useState<string[] | null>(null);
  const labelOf = (key: string) => spec?.fields.find(field => field.key === key)?.label ?? key;
  const plainFacts = Object.entries(item.fields).filter(([, value]) => value);
  const dates = Object.entries(item.dates).filter(([, value]) => value);
  return (
    <Card>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="break-words font-display text-base font-semibold">{item.label}</h3>
          <p className="text-xs text-muted-foreground">{spec?.label ?? item.kind} · updated {day(item.updatedAt)}</p>
        </div>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setEditing(v => !v); setSensitivity(null); }}>{editing ? 'Close' : 'Edit'}</Button>
      </div>
      {editing && spec ? <div className="mt-3 space-y-4">
        <FactsForm spec={spec} secretKeys={item.secretKeys} initial={item} submitLabel="Save" busy={busy} onCancel={() => setEditing(false)}
          onSubmit={async body => { if (await act(() => api.put(`/my-world/items/${item.id}`, body), `Saved ${body.label}.`)) setEditing(false); }} />
        <div className="rounded-md border border-border p-3">
          <p className="text-sm font-medium">Which fields are secret</p>
          <p className="text-xs text-muted-foreground">A secret field is kept sealed and shown only behind your password. Making a field secret removes its plain value; set it again with Set….</p>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
            {spec.fields.map(field => {
              const chosen = sensitivity ?? item.secretKeys;
              return <label key={field.key} className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={chosen.includes(field.key)} disabled={busy}
                  onChange={e => setSensitivity(e.target.checked ? [...chosen, field.key] : chosen.filter(key => key !== field.key))} />{field.label}
              </label>;
            })}
          </div>
          {sensitivity ? <Button className="mt-2" type="button" disabled={busy || !sensitivity.length} onClick={() => {
            const keys = sensitivity;
            const exposed = item.secretKeys.filter(key => !keys.includes(key) && item.secretsSet.includes(key));
            if (exposed.length && !window.confirm(`${exposed.map(labelOf).join(', ')} will no longer be secret. Its sealed value stays sealed until you clear it. Continue?`)) return;
            void act(() => api.put(`/my-world/items/${item.id}/sensitivity`, { secretKeys: keys }), 'Saved which fields are secret.').then(ok => { if (ok) setSensitivity(null); });
          }}>Save secret fields</Button> : null}
        </div>
      </div> : <>
        {plainFacts.length || dates.length ? <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          {plainFacts.map(([key, value]) => <div key={key} className="contents"><dt className="text-muted-foreground">{labelOf(key)}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
          {dates.map(([key, value]) => <div key={key} className="contents"><dt className="text-muted-foreground">{spec?.dates.find(date => date.key === key)?.label ?? key}</dt><dd>{day(value)}</dd></div>)}
        </dl> : null}
      </>}
      {item.secretKeys.length ? <ul className="mt-3 space-y-2">
        {item.secretKeys.map(key => <SecretRow key={key} item={item} fieldKey={key} fieldLabel={labelOf(key)} unlocked={unlocked} busy={busy} act={act} onNeedUnlock={onNeedUnlock} />)}
      </ul> : null}
      <div className="mt-3">
        <Button type="button" variant="danger" disabled={busy} onClick={() => {
          if (!window.confirm(`Remove ${item.label} from your World? Its facts, its secret fields and what Josi knows about it are removed.`)) return;
          void act(() => api.del(`/my-world/items/${item.id}`), `Removed ${item.label}.`);
        }}>Remove…</Button>
      </div>
    </Card>
  );
}

function MemoryLine({ line, about, busy, act }: { line: Line; about: string | null; busy: boolean; act: (work: () => Promise<unknown>, note?: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(line.content);
  return (
    <li className="rounded-md border border-border p-2">
      {editing ? <form className="flex flex-wrap items-center gap-2" onSubmit={event => {
        event.preventDefault();
        void act(() => api.put(`/my-world/memory/${line.id}`, { content: text.trim() }), 'Saved.').then(ok => { if (ok) setEditing(false); });
      }}>
        <Input className="min-w-0 flex-1" value={text} onChange={e => setText(e.target.value)} required maxLength={500} aria-label="What Josi knows" />
        <Button type="submit" disabled={busy || !text.trim()}>Save</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setEditing(false); setText(line.content); }}>Cancel</Button>
      </form> : <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 break-words text-sm">{line.content}{about ? <span className="ml-1 text-xs text-muted-foreground">· {about}</span> : null}</p>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setText(line.content); setEditing(true); }}>Edit</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => void act(() => api.del(`/my-world/memory/${line.id}`), 'Forgotten.')}>Forget</Button>
      </div>}
    </li>
  );
}

export function MyWorld() {
  const [world, setWorld] = useState<World | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addKind, setAddKind] = useState('');
  const [filter, setFilter] = useState('all');
  const [password, setPassword] = useState('');
  const [newLine, setNewLine] = useState('');
  const unlockField = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try { setWorld(await api.get<World>('/my-world')); }
    catch (e) { setError(message(e, 'Your World could not be loaded.')); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // The five-minute unlock runs out on the server; look again now and then so
  // the page does not keep offering Show after it has.
  useEffect(() => { if (!world?.unlocked) return; const timer = window.setTimeout(() => void load(), 5 * 60_000 + 2000); return () => window.clearTimeout(timer); }, [world?.unlocked, load]);

  const act = useCallback(async (work: () => Promise<unknown>, done?: string): Promise<boolean> => {
    setBusy(true); setError(''); setNote('');
    try { await work(); if (done) setNote(done); await load(); return true; }
    catch (e) { setError(message(e, 'That did not go through.')); return false; }
    finally { setBusy(false); }
  }, [load]);
  const needUnlock = useCallback(() => {
    setError('Unlock with your password first to show secret fields.');
    unlockField.current?.focus();
  }, []);

  const kinds = world?.kinds ?? [];
  const addSpec = kinds.find(kind => kind.kind === addKind) ?? kinds[0];
  const items = world?.items ?? [];
  const groups = [...kinds.map(spec => ({ key: spec.kind, title: spec.plural, spec, items: items.filter(item => item.kind === spec.kind) })),
    { key: '__other', title: 'Other', spec: undefined, items: items.filter(item => !kinds.some(spec => spec.kind === item.kind)) }]
    .filter(group => group.items.length && (filter === 'all' || filter === group.key));
  const labelOfItem = (id: string | null) => id ? items.find(item => item.id === id)?.label ?? null : null;

  return <div className="page">
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-0 flex-1">
        <h1 className="page-title">My World</h1>
        <p className="text-sm text-muted-foreground">Who am I? Everything about you, kept in your Vault. Josi fills it in from conversation; secrets never pass through her.</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" disabled={!world} onClick={() => { setAdding(v => !v); setAddKind(current => current || kinds[0]?.kind || ''); }}>{adding ? 'Close' : 'Add…'}</Button>
        <Button type="button" variant="secondary" disabled={busy} onClick={() => { setLoading(true); void load(); }}>Refresh</Button>
      </div>
    </div>
    {error ? <ErrorNote>{error}</ErrorNote> : null}
    {note ? <p className="text-sm" role="status">{note}</p> : null}

    {!world ? <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'Your World has not loaded.'}</p> : <>
      <Card>
        {world.unlocked
          ? <p className="text-sm">Unlocked. Secret fields can be shown on this screen for five minutes.</p>
          : <form className="flex flex-wrap items-end gap-2" onSubmit={event => {
            event.preventDefault();
            const secret = password; setPassword('');
            void act(() => api.post('/vault/unlock', { password: secret }), 'Unlocked. Secret fields can be shown for five minutes.');
          }}>
            <label className="flex min-w-0 flex-1 flex-col gap-1 text-sm">Your Josi password
              <input ref={unlockField} className="min-h-11 w-full min-w-0 rounded-xl border border-border bg-input px-3.5 text-base focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring sm:text-sm" type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} required disabled={busy} /></label>
            <Button type="submit" disabled={busy || !password}>Unlock for five minutes</Button>
            <p className="w-full text-xs text-muted-foreground">Needed only to show a secret field. Setting or clearing one does not need it.</p>
          </form>}
      </Card>

      {adding && addSpec ? <Card>
        <CardTitle>Add to your World</CardTitle>
        <label className="mb-3 block text-sm">What kind of thing
          <select className={`mt-1 ${selectClass}`} value={addSpec.kind} onChange={e => setAddKind(e.target.value)}>
            {kinds.map(kind => <option key={kind.kind} value={kind.kind}>{kind.label}</option>)}
          </select>
        </label>
        <FactsForm key={addSpec.kind} spec={addSpec} secretKeys={addSpec.fields.filter(field => field.secret).map(field => field.key)} submitLabel="Add" busy={busy}
          onCancel={() => setAdding(false)}
          onSubmit={async body => { if (await act(() => api.post('/my-world/items', { kind: addSpec.kind, ...body }), `Added ${body.label}. Secret fields can be set on its card.`)) setAdding(false); }} />
      </Card> : null}

      {items.length ? <label className="block max-w-xs text-sm">Show
        <select className={`mt-1 ${selectClass}`} value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">Everything</option>
          {kinds.filter(kind => items.some(item => item.kind === kind.kind)).map(kind => <option key={kind.kind} value={kind.kind}>{kind.plural}</option>)}
        </select>
      </label> : null}

      {!items.length ? <Card>
        <CardTitle>Nothing here yet</CardTitle>
        <p className="text-sm text-muted-foreground">Tell Josi about your life ("I just bought a 2026 Ford Explorer", "Dana is my daughter") or use Add. Secret fields, like a plate or a card number, are typed into a protected box, never into the chat.</p>
      </Card> : groups.map(group => <section key={group.key} className="space-y-3" aria-label={group.title}>
        <h2 className="font-display text-lg font-semibold">{group.title}</h2>
        {group.items.map(item => <ItemCard key={`${item.id}:${item.updatedAt}`} item={item} spec={group.spec} unlocked={world.unlocked} busy={busy} act={act} onNeedUnlock={needUnlock} />)}
      </section>)}

      <Card>
        <CardTitle>Josi knows</CardTitle>
        <p className="mb-2 text-xs text-muted-foreground">What Josi remembers about your World. Correct anything, or tell her to forget it.</p>
        {world.memory.length ? <ul className="space-y-2">
          {world.memory.map(line => <MemoryLine key={`${line.id}:${line.content}`} line={line} about={labelOfItem(line.itemId)} busy={busy} act={act} />)}
        </ul> : <p className="text-sm text-muted-foreground">Nothing yet.</p>}
        <form className="mt-3 flex flex-wrap items-center gap-2" onSubmit={event => {
          event.preventDefault();
          const content = newLine.trim();
          void act(() => api.post('/my-world/memory', { content }), 'Added.').then(ok => { if (ok) setNewLine(''); });
        }}>
          <Input className="min-w-0 flex-1" value={newLine} onChange={e => setNewLine(e.target.value)} maxLength={500} placeholder="Something Josi should know, in a sentence" aria-label="Something Josi should know" />
          <Button type="submit" disabled={busy || !newLine.trim()}>Add</Button>
        </form>
      </Card>
    </>}
  </div>;
}
