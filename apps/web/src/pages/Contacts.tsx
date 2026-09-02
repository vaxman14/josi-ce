import { useEffect, useState } from 'react';
import { api, type Contact } from '@/lib/api';
import { Button, Card, Empty, ErrorNote, Input } from '@/components/ui';

export function Contacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () =>
    api.get<{ contacts: Contact[] }>('/assistant/contacts').then((r) => setContacts(r.contacts)).catch(() => undefined);

  useEffect(() => { void load(); }, []);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      await api.post('/assistant/contacts', {
        name: form.get('name'), email: form.get('email'), phone: form.get('phone'),
      });
      event.currentTarget.reset();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save that');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Contacts</h1>
      <p className="text-sm text-muted-foreground">Private to you, like your conversations.</p>

      <Card>
        <form onSubmit={create} className="space-y-3">
          <div>
            <label className="mb-1 block text-sm" htmlFor="c-name">Name</label>
            <Input id="c-name" name="name" required />
          </div>
          <div>
            <label className="mb-1 block text-sm" htmlFor="c-email">Email</label>
            <Input id="c-email" name="email" type="email" inputMode="email" />
          </div>
          <div>
            <label className="mb-1 block text-sm" htmlFor="c-phone">Phone</label>
            <Input id="c-phone" name="phone" type="tel" inputMode="tel" />
          </div>
          {error ? <ErrorNote>{error}</ErrorNote> : null}
          <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add contact'}</Button>
        </form>
      </Card>

      <ContactSyncPanel onChanged={() => void load()} />

      {contacts.length === 0 ? (
        <Empty title="No contacts yet" />
      ) : (
        <ul className="space-y-2">
          {contacts.map((c) => (
            <li key={c.id}>
              <Card>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="min-w-0 truncate text-sm font-medium">{c.name ?? 'Unnamed'}</p>
                  {/* LB8.7. A synced contact that looks identical to one
                      somebody typed is a contact nobody can reason about when
                      it changes on its own. */}
                  {c.source && c.source !== 'josi' ? (
                    <span className="text-xs text-muted-foreground">
                      {SOURCE_LABEL[c.source] ?? c.source}
                      {c.source_account ? ` · ${c.source_account}` : ''}
                    </span>
                  ) : null}
                </div>
                {c.email ? <p className="truncate text-sm text-muted-foreground">{c.email}</p> : null}
                {c.phone ? <p className="truncate text-sm text-muted-foreground">{c.phone}</p> : null}
                {c.conflict_state === 'both_changed' ? (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Changed here and at {SOURCE_LABEL[c.source ?? ''] ?? 'the provider'} since the last
                    sync. Nothing was overwritten — edit it here to settle it.
                  </p>
                ) : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  google: 'Google',
  microsoft: 'Microsoft',
  device: 'Your phone',
};

interface Origin {
  id: string;
  provider: 'google' | 'microsoft';
  sourceAccount: string;
  syncMode: 'import_only' | 'two_way';
  status: 'idle' | 'syncing' | 'error' | 'paused' | 'disconnected';
  lastSyncAt: string | null;
  lastErrorCategory: string | null;
  counts: Record<string, number>;
}

const STATUS_TEXT: Record<Origin['status'], string> = {
  idle: 'Syncing',
  syncing: 'Syncing now',
  error: 'Not working',
  paused: 'Paused',
  disconnected: 'Stopped',
};

/** Which accounts are syncing, and what happened last time.
 *
 * Suggestions are shown, never applied: `findDuplicates` decides what is worth
 * asking about, and only the same record seen twice is ever merged unattended.
 */
function ContactSyncPanel({ onChanged }: { onChanged: () => void }) {
  const [origins, setOrigins] = useState<Origin[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [review, setReview] = useState<Array<{ left: string; right: string; reason: string }>>([]);

  const load = () =>
    api.get<{ origins: Origin[] }>('/contacts/sync')
      .then((r) => setOrigins(r.origins))
      .catch(() => setOrigins([]));

  useEffect(() => { void load(); }, []);

  async function act(path: string, id: string) {
    setBusy(id);
    setError('');
    try {
      const result = await api.post<{ needsReview?: typeof review }>(path, {});
      if (result?.needsReview) setReview(result.needsReview);
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    } finally {
      setBusy('');
    }
  }

  if (!origins || origins.length === 0) return null;

  return (
    <Card>
      <p className="mb-2 text-sm font-medium">Synced accounts</p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      <ul className="space-y-3">
        {origins.map((o) => (
          <li key={o.id} className="border-t border-input pt-3 first:border-0 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="min-w-0 truncate text-sm">
                {SOURCE_LABEL[o.provider]} · {o.sourceAccount}
              </span>
              <span className="text-xs text-muted-foreground">
                {STATUS_TEXT[o.status]}
                {o.syncMode === 'two_way' ? ' · two-way' : ' · import only'}
              </span>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {o.lastSyncAt ? `Last synced ${new Date(o.lastSyncAt).toLocaleString()}` : 'Not synced yet'}
              {o.status === 'error' && o.lastErrorCategory
                ? ` · ${o.lastErrorCategory === 'insufficient_scope'
                    ? 'permission was removed — reconnect to fix it'
                    : o.lastErrorCategory.replace(/_/g, ' ')}`
                : ''}
            </p>
            {o.status !== 'disconnected' ? (
              <div className="mt-2 flex flex-wrap gap-2">
                <Button type="button" disabled={!!busy} onClick={() => void act(`/contacts/sync/${o.id}/run`, o.id)}>
                  {busy === o.id ? 'Syncing…' : 'Sync now'}
                </Button>
                <Button type="button" variant="secondary" disabled={!!busy}
                        onClick={() => void act(`/contacts/sync/${o.id}/stop`, o.id)}>
                  Stop syncing
                </Button>
              </div>
            ) : (
              <p className="mt-1 text-xs text-muted-foreground">
                Stopped. The contacts it brought are still here, and nothing was changed at the provider.
              </p>
            )}
          </li>
        ))}
      </ul>

      {review.length ? (
        <div className="mt-3 border-t border-input pt-3">
          <p className="text-sm font-medium">Possible duplicates</p>
          <p className="mb-2 text-xs text-muted-foreground">
            Nothing has been merged. Josi only joins records automatically when they are the same
            record from the same account.
          </p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {review.map((r) => <li key={`${r.left}:${r.right}`}>• {r.reason}</li>)}
          </ul>
        </div>
      ) : null}
    </Card>
  );
}
