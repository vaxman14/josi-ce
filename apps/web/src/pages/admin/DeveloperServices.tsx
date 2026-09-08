// Who is permitted to connect a developer service.
//
// The one thing this page governs is PERMISSION. GitHub, Netlify, Vercel and
// Supabase are each person's own account, connected with their own token in
// their own Workspace — so there is no credential field here, and no route
// behind this page accepts one.
//
// The second thing it must get right is not conflating "allowed" with
// "connected". A service permitted for everyone that nobody has connected and a
// service nobody may connect look identical if you only count connections, and
// an administrator reading the second as the first concludes their team does
// not want a tool they were never able to use. Permission and health are two
// separate blocks on every card, and they are labelled as such.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '@/lib/api';
import { Badge, Button, CollapsibleCard, Empty, ErrorNote, Input } from '@/components/ui';

type Mode = 'not_allowed' | 'everyone' | 'specific_users';

interface Person {
  id: string;
  username: string;
  email: string;
}

interface ConnectionHealth {
  userId: string;
  username: string;
  accountLabel: string | null;
  status: string;
  lastCheckAt: string | null;
  lastCheckOk: boolean | null;
  lastError: string | null;
}

interface ServiceRow {
  service: string;
  label: string;
  capability: string;
  mode: Mode;
  allowedUserIds: string[];
  note: string | null;
  summary: string;
  connections: ConnectionHealth[];
}

interface AdminView {
  people: Person[];
  services: ServiceRow[];
}

const MODE_LABEL: Record<Mode, string> = {
  not_allowed: 'Not allowed',
  everyone: 'Allowed for everyone',
  specific_users: 'Allowed for specific people',
};

export function AdminDeveloperServices() {
  const [view, setView] = useState<AdminView | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await api.get<AdminView>('/admin/developer-services'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read developer services');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
      <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm">
        More integrations are coming soon. Have a special request?{' '}
        <a className="underline" href="mailto:roman@socalreceptionist.com">Email us at roman@socalreceptionist.com</a>.
      </div>
      <p className="text-sm text-muted-foreground">
        Each person connects their own GitHub, Netlify, Vercel or Supabase account from their
        Workspace, with their own token. What you decide here is who is permitted to do that.
        You never enter a credential for anybody, and you cannot see one.
      </p>
      <div className="rounded-lg border border-border p-3">
        <p className="font-medium">Custom API</p>
        <p className="mt-1 text-sm text-muted-foreground">Connect a REST API through an explicit endpoint allowlist. Read actions can run directly; write and delete actions require approval.</p>
        <Link className="mt-2 inline-block text-sm underline" to="/admin/custom-apis">Manage Custom APIs</Link>
      </div>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!view ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {(view?.services ?? []).map((row) => (
        <ServiceCard key={row.service} row={row} people={view!.people} onSaved={load} />
      ))}
    </div>
  );
}

function ServiceCard(
  { row, people, onSaved }: { row: ServiceRow; people: Person[]; onSaved: () => Promise<void> },
) {
  const [mode, setMode] = useState<Mode>(row.mode);
  const [selected, setSelected] = useState<string[]>(row.allowedUserIds);
  const [note, setNote] = useState(row.note ?? '');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The server's state is the truth; a reload after saving must not be masked
  // by whatever this component was last holding.
  useEffect(() => {
    setMode(row.mode);
    setSelected(row.allowedUserIds);
    setNote(row.note ?? '');
  }, [row.mode, row.allowedUserIds, row.note]);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) => p.username.toLowerCase().includes(q) || p.email.toLowerCase().includes(q),
    );
  }, [people, search]);

  /** Said in the same words the server would use, so the preview and the saved
   * summary cannot disagree. */
  const preview = (() => {
    if (mode === 'everyone') return 'Anyone with an account here can connect their own.';
    if (mode === 'not_allowed') return 'Nobody here can connect this service.';
    if (!selected.length) {
      return 'Nobody yet — "specific people" is selected but no one has been chosen.';
    }
    const names = selected
      .map((id) => people.find((p) => p.id === id)?.username ?? 'someone removed')
      .slice(0, 3);
    const rest = selected.length - names.length;
    return rest > 0
      ? `${names.join(', ')} and ${rest} more can connect their own.`
      : `${names.join(', ')} can connect their own.`;
  })();

  const dirty = mode !== row.mode
    || note !== (row.note ?? '')
    || selected.join(',') !== row.allowedUserIds.join(',');

  async function save() {
    setBusy(true);
    setError('');
    try {
      await api.put(`/admin/developer-services/${row.service}`, {
        mode, note, userIds: mode === 'specific_users' ? selected : [],
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be saved');
    } finally {
      setBusy(false);
    }
  }

  const needsAttention = row.connections.some((c) => c.lastCheckOk === false);
  return (
    <CollapsibleCard
      title={row.label}
      summary={row.capability}
      status={<><Badge tone={row.mode === 'not_allowed' ? 'muted' : 'ok'}>{MODE_LABEL[row.mode]}</Badge>{needsAttention ? <Badge tone="danger">Needs attention</Badge> : null}</>}
      defaultOpen={needsAttention}
    >
      <p className="mt-1 text-sm text-muted-foreground">{row.capability}</p>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}

      {/* ---- permission ---- */}
      <div className="mt-3 space-y-2">
        <p className="text-sm font-medium">Who may connect this</p>
        {(['not_allowed', 'everyone', 'specific_users'] as Mode[]).map((m) => (
          <label key={m} className="flex min-h-11 items-center gap-2 text-sm">
            <input
              type="radio"
              name={`mode-${row.service}`}
              className="h-4 w-4"
              checked={mode === m}
              onChange={() => setMode(m)}
            />
            {MODE_LABEL[m]}
          </label>
        ))}

        {mode === 'specific_users' ? (
          <div className="rounded-md border border-border p-2">
            <label className="mb-1 block text-sm" htmlFor={`search-${row.service}`}>
              Find people
            </label>
            <Input
              id={`search-${row.service}`}
              value={search}
              placeholder="Name or email"
              autoCapitalize="none"
              onChange={(e) => setSearch(e.target.value)}
            />
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {matches.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={selected.includes(p.id)}
                      onChange={(e) => setSelected((prev) => (
                        e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)
                      ))}
                    />
                    <span className="min-w-0">
                      <span className="block">{p.username}</span>
                      <span className="block text-xs text-muted-foreground">{p.email}</span>
                    </span>
                  </label>
                </li>
              ))}
              {!matches.length ? (
                <li className="py-2 text-sm text-muted-foreground">Nobody matches that.</li>
              ) : null}
            </ul>
          </div>
        ) : null}

        <div>
          <label className="mb-1 block text-sm" htmlFor={`note-${row.service}`}>
            Reason to show anyone who cannot connect it (optional)
          </label>
          <Input
            id={`note-${row.service}`}
            value={note}
            placeholder="Ask the platform team if you need this."
            onChange={(e) => setNote(e.target.value)}
          />
        </div>

        {/* The effective scope in a sentence, so "specific people" never leaves
            an administrator unsure whether they finished choosing. */}
        <p className="text-sm text-muted-foreground">{dirty ? preview : row.summary}</p>

        <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save who may connect'}
        </Button>
      </div>

      {/* ---- health, deliberately separate ---- */}
      <div className="mt-4 border-t border-border pt-3">
        <p className="text-sm font-medium">Who has actually connected</p>
        {!row.connections.length ? (
          <Empty title="Nobody has connected this">
            {row.mode === 'not_allowed'
              // The distinction the whole card exists to preserve.
              ? 'Nobody is permitted to, so this is not a sign of whether anyone wants it.'
              : 'They are permitted to; none of them has yet.'}
          </Empty>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {row.connections.map((c) => (
              <li key={c.userId} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block text-sm">{c.username}</span>
                  <span className="block text-xs text-muted-foreground">
                    {c.accountLabel ?? 'account not named'}
                    {c.lastCheckAt ? ` · checked ${new Date(c.lastCheckAt).toLocaleString()}` : ''}
                  </span>
                  {c.lastCheckOk === false && c.lastError ? (
                    <span className="block text-xs text-red-600 dark:text-red-400">{c.lastError}</span>
                  ) : null}
                </span>
                <Badge tone={c.lastCheckOk === false ? 'danger' : c.status === 'active' ? 'ok' : 'muted'}>
                  {c.lastCheckOk === false ? 'needs attention' : c.status}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </CollapsibleCard>
  );
}
