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

      {contacts.length === 0 ? (
        <Empty title="No contacts yet" />
      ) : (
        <ul className="space-y-2">
          {contacts.map((c) => (
            <li key={c.id}>
              <Card>
                <p className="truncate text-sm font-medium">{c.name ?? 'Unnamed'}</p>
                {c.email ? <p className="truncate text-sm text-muted-foreground">{c.email}</p> : null}
                {c.phone ? <p className="truncate text-sm text-muted-foreground">{c.phone}</p> : null}
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
