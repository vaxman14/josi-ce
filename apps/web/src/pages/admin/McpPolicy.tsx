// Who may add their own MCP servers.
//
// One permission for the whole installation, set by the owner, in the same
// three choices as a developer service: nobody, everyone, or named people.
// The owner is always permitted and is not on the list.
//
// Like the developer services page this governs PERMISSION and nothing else.
// There is no credential field, the owner cannot see anybody's sign-in or
// tools, and "allowed" is kept apart from "has added one".
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { Badge, Button, CollapsibleCard, Empty, ErrorNote, Input } from '@/components/ui';
import { plain } from '@/lib/plainLanguage';
import { useUnsavedChanges } from '@/lib/useUnsavedChanges';

type Mode = 'not_allowed' | 'everyone' | 'specific_users';

interface Person { id: string; username: string; email: string }
interface Added { userId: string; username: string; name: string; host: string; status: string; enabled: boolean; lastCheckAt: string | null; lastCheckOk: boolean | null }
interface PolicyView {
  mode: Mode;
  note: string | null;
  allowedUserIds: string[];
  summary: string;
  people: Person[];
  connections: Added[];
}

const MODE_LABEL: Record<Mode, string> = {
  not_allowed: 'Not allowed',
  everyone: 'Allowed for everyone',
  specific_users: 'Allowed for specific people',
};

export function McpPolicyCard() {
  const [view, setView] = useState<PolicyView | null>(null);
  const [mode, setMode] = useState<Mode>('not_allowed');
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    const res = await api.get<PolicyView>('/admin/mcp/policy');
    setView(res);
    setMode(res.mode);
    setSelected(res.allowedUserIds);
    setNote(res.note ?? '');
  }, []);
  useEffect(() => { void load().catch((err) => setError(err instanceof Error ? err.message : 'Could not read the MCP permission')); }, [load]);

  const people = view?.people ?? [];
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? people.filter((p) => p.username.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)) : people;
  }, [people, search]);

  const dirty = !!view && (mode !== view.mode || note !== (view.note ?? '') || selected.join(',') !== view.allowedUserIds.join(','));
  useUnsavedChanges(dirty);

  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      await api.put('/admin/mcp/policy', { mode, note, userIds: mode === 'specific_users' ? selected : undefined });
      await load();
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That could not be saved');
    } finally {
      setBusy(false);
    }
  }

  const preview = mode === 'everyone' ? 'Anyone with an account here can add their own MCP servers.'
    : mode === 'not_allowed' ? 'Only you, the owner, can add MCP servers.'
      : selected.length ? `${selected.length} ${selected.length === 1 ? 'person' : 'people'} you chose, and you, can add their own.`
        : 'Nobody yet — "specific people" is selected but no one has been chosen.';

  return (
    <CollapsibleCard
      title="Custom MCP servers"
      summary="Who may add their own outside tool servers"
      status={<Badge tone={(view?.mode ?? 'not_allowed') === 'not_allowed' ? 'muted' : 'ok'}>{MODE_LABEL[view?.mode ?? 'not_allowed']}</Badge>}
    >
      <p className="mt-1 text-sm text-muted-foreground">
        An MCP server is a web address that gives Josi extra tools. Each person adds their own, with their own sign-in,
        and only their own conversations can use it. You decide here whether people other than you may do that.
        You are always able to add your own.
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        Whoever adds a server chooses to trust it. Josi runs a server&apos;s tool on its own only when the server marks it as
        read-only; every other tool asks that person first, each time.
      </p>
      {error ? <div className="mt-2"><ErrorNote>{error}</ErrorNote></div> : null}

      <div className="mt-3 space-y-2">
        <p className="text-sm font-medium">Who may add MCP servers</p>
        {(['not_allowed', 'everyone', 'specific_users'] as Mode[]).map((m) => (
          <label key={m} className="flex min-h-11 items-center gap-2 text-sm">
            <input type="radio" name="mcp-policy-mode" className="h-4 w-4" checked={mode === m} onChange={() => setMode(m)} />
            {MODE_LABEL[m]}
          </label>
        ))}

        {mode === 'specific_users' ? (
          <div className="rounded-md border border-border p-2">
            <label className="mb-1 block text-sm" htmlFor="mcp-policy-search">Find people</label>
            <Input id="mcp-policy-search" value={search} placeholder="Name or email" autoCapitalize="none" onChange={(e) => setSearch(e.target.value)} />
            <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
              {matches.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox" className="h-4 w-4" checked={selected.includes(p.id)}
                      onChange={(e) => setSelected((prev) => (e.target.checked ? [...prev, p.id] : prev.filter((id) => id !== p.id)))}
                    />
                    <span className="min-w-0">
                      <span className="block">{p.username}</span>
                      <span className="block text-xs text-muted-foreground">{p.email}</span>
                    </span>
                  </label>
                </li>
              ))}
              {!matches.length ? <li className="py-2 text-sm text-muted-foreground">Nobody matches that.</li> : null}
            </ul>
          </div>
        ) : null}

        <div>
          <label className="mb-1 block text-sm" htmlFor="mcp-policy-note">Reason to show anyone who cannot add one (optional)</label>
          <Input id="mcp-policy-note" value={note} maxLength={500} placeholder="Ask me if you need this." onChange={(e) => setNote(e.target.value)} />
        </div>

        <p className="text-sm text-muted-foreground">{dirty ? preview : view?.summary}</p>
        <Button type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save who may add servers'}
        </Button>
        {saved && !dirty ? <p role="status">MCP server permission saved.</p> : null}
      </div>

      <div className="mt-4 border-t border-border pt-3">
        <p className="text-sm font-medium">Who has added one</p>
        {!view?.connections.length ? (
          <Empty title="Nobody has added an MCP server">
            {(view?.mode ?? 'not_allowed') === 'not_allowed'
              ? 'Only you are permitted to, so this is not a sign of whether anyone wants one.'
              : 'They are permitted to; none of them has yet.'}
          </Empty>
        ) : (
          <ul className="mt-1 divide-y divide-border">
            {view.connections.map((c, index) => (
              <li key={`${c.userId}-${index}`} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span className="min-w-0">
                  <span className="block text-sm">{c.username} · {c.name}</span>
                  <span className="block break-all text-xs text-muted-foreground">
                    {c.host}{c.lastCheckAt ? ` · checked ${new Date(c.lastCheckAt).toLocaleString()}` : ''}
                  </span>
                </span>
                <Badge tone={!c.enabled ? 'muted' : c.lastCheckOk === false ? 'danger' : 'ok'}>
                  {c.enabled ? plain('mcp_status', c.status) : 'Switched off'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>
    </CollapsibleCard>
  );
}
