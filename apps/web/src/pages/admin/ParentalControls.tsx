// The paid module, as the person who administers the installation sees it.
//
// THIS PAGE IS BILLING, NOT AUTHORITY, and it says so on itself. An
// administrator activates a licence here and gains nothing by it: they cannot
// see who is looking after whom, cannot read a child's conversations, cannot
// change anybody's hours, and there is no route that would let them. The
// screen states that plainly rather than leaving somebody to discover it —
// an administrator who believes they have oversight here would be wrong in a
// way that matters.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, Input } from '@/components/ui';
import { plain, plainDetail } from '@/lib/plainLanguage';

interface Entitlement {
  state: string;
  entitled: boolean;
  issuedTo: string | null;
  licenseId: string | null;
  expiresAt: string | null;
  activatedAt: string | null;
  boundToThisInstallation: boolean;
  canVerifyLicenses: boolean;
  honesty: { scope: string; notDevice: string; minutes: string; admin: string };
  note: string;
}

export function AdminParentalControls() {
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [license, setLicense] = useState('');
  const [error, setError] = useState('');
  const [note, setNote] = useState('');

  const load = useCallback(async () => {
    try {
      setEntitlement(await api.get<Entitlement>('/admin/parental-controls'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load this page');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function activate(event: React.FormEvent) {
    event.preventDefault();
    setError(''); setNote('');
    try {
      setEntitlement(await api.post<Entitlement>('/admin/parental-controls/license', { license }));
      setLicense('');
      setNote('Activated. People here can now set up a managed account for a child.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That licence was not accepted');
    }
  }

  async function revoke() {
    setError(''); setNote('');
    try {
      setEntitlement(await api.del<Entitlement>('/admin/parental-controls/license'));
      setNote('Switched off. Accounts and conversations are untouched; the controls simply stop applying.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That did not work');
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Parental Controls</h1>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {note ? <p className="text-sm text-emerald-400">{note}</p> : null}
      {!entitlement ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {entitlement ? (
        <>
          <Card>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <CardTitle>This installation</CardTitle>
              <Badge tone={entitlement.entitled ? 'ok' : 'muted'}>
                {plain('entitlement_state', entitlement.state)}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {plainDetail('entitlement_state', entitlement.state) ?? entitlement.note}
            </p>
            {entitlement.issuedTo ? (
              <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                <div><dt className="text-muted-foreground">Issued to</dt><dd>{entitlement.issuedTo}</dd></div>
                <div><dt className="text-muted-foreground">Licence</dt><dd>{entitlement.licenseId}</dd></div>
                <div>
                  <dt className="text-muted-foreground">Expires</dt>
                  <dd>{entitlement.expiresAt ? new Date(entitlement.expiresAt).toLocaleDateString() : 'Does not expire'}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Tied to this installation</dt>
                  <dd>{entitlement.boundToThisInstallation ? 'Yes' : 'No'}</dd>
                </div>
              </dl>
            ) : null}
          </Card>

          <Card>
            <CardTitle>What you get, and what you do not</CardTitle>
            <p className="text-sm text-muted-foreground">{entitlement.note}</p>
            <p className="mt-2 text-sm text-muted-foreground">{entitlement.honesty.admin}</p>
            <p className="mt-2 text-sm text-muted-foreground">{entitlement.honesty.scope}</p>
            <p className="mt-2 text-sm text-muted-foreground">{entitlement.honesty.notDevice}</p>
          </Card>

          <Card>
            <CardTitle>{entitlement.entitled ? 'Replace the licence' : 'Activate a licence'}</CardTitle>
            {!entitlement.canVerifyLicenses ? (
              <p className="text-sm text-muted-foreground">
                This build carries no publisher key, so it cannot check a licence and will refuse
                every one. Paid modules are available on builds published by SOCAL RECEPTIONIST
                LLC. Nothing you paste here can change that — it is a property of the image, not
                a setting.
              </p>
            ) : (
              <form onSubmit={activate} className="space-y-3">
                <div>
                  <label className="mb-1 block text-sm" htmlFor="license">Licence key</label>
                  <Input id="license" value={license} onChange={(e) => setLicense(e.target.value)}
                    placeholder="josi-lic.1.…" required />
                </div>
                <Button type="submit">Activate</Button>
              </form>
            )}
            {entitlement.entitled ? (
              <div className="mt-4 border-t border-border pt-3">
                <Button variant="danger" onClick={() => void revoke()}>Switch the module off</Button>
                <p className="mt-2 text-sm text-muted-foreground">
                  Families keep their accounts and their conversations. The hours and limits stop
                  applying, and parents stop being able to see anything — in both directions, so
                  nobody is held to a rule nobody may change.
                </p>
              </div>
            ) : null}
          </Card>
        </>
      ) : null}
    </div>
  );
}
