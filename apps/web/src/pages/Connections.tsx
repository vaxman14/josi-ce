// Connected accounts.
//
// Phase 6 shipped this page saying plainly that connecting was not available.
// Phase 7 makes it real, and the honesty rule still applies: nothing here is
// pressable unless it works. If an administrator has not registered the
// installation's own OAuth application, the page says so instead of offering a
// Connect button that would fail at the provider.
//
// Every write capability shows what it permits before it can be switched on.
// A toggle labelled only "Send email" is not consent.
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { Badge, Button, Card, CardTitle, ErrorNote, NotYet } from '@/components/ui';
import { CloudFolders } from '@/components/CloudFolders';
import { plain } from '@/lib/plainLanguage';

interface Capability {
  key: string;
  label: string;
  kind: 'read' | 'write';
  consequence?: string;
  state: 'needs_consent' | 'blocked_by_admin' | 'off' | 'on';
  needsConsent: boolean;
  adminNote: string | null;
}

interface ProviderView {
  provider: 'google' | 'microsoft';
  available: boolean;
  connection: {
    id: string;
    account: string | null;
    status: string;
    lastCheckAt: string | null;
    lastCheckOk: boolean | null;
    errorCategory: string | null;
  } | null;
  capabilities: Capability[];
}

const PROVIDER_LABEL: Record<string, string> = { google: 'Google', microsoft: 'Microsoft 365' };

/** What each failure means to the person who has to fix it. A raw category is
 * not an explanation. */
const ERROR_TEXT: Record<string, string> = {
  revoked: 'Access was withdrawn at the provider. Reconnect to restore it.',
  expired: 'The stored access expired and could not be renewed. Reconnect.',
  insufficient_scope: 'A permission Josi needs was not granted. Reconnect and approve it.',
  rate_limited: 'The provider is rate limiting us. This usually clears on its own.',
  provider_error: 'The provider returned an error. If it persists, reconnect.',
  network: 'Josi could not reach the provider.',
};

export function Connections() {
  const [providers, setProviders] = useState<ProviderView[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.get<{ providers: ProviderView[] }>('/connections');
      setProviders(res.providers);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load your connections');
    }
  }, []);

  useEffect(() => {
    void load();
    // The callback comes back with ?error=… when a handshake was refused.
    const reason = new URLSearchParams(window.location.search).get('error');
    if (reason) setError(handshakeError(reason));
  }, [load]);

  async function connect(provider: string, capabilities: string[] = []) {
    setBusy(provider);
    setError('');
    try {
      const res = await api.post<{ url: string }>(`/connections/${provider}/start`, { capabilities });
      // Leaving the app is the point: consent happens at the provider.
      window.location.assign(res.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the connection');
      setBusy(null);
    }
  }

  async function toggle(view: ProviderView, capability: Capability) {
    if (!view.connection) return;
    // M32: a capability the provider never granted needs another trip through
    // consent, not a stored wish.
    if (capability.needsConsent) {
      await connect(view.provider, [capability.key]);
      return;
    }
    setBusy(capability.key);
    setError('');
    try {
      await api.put(`/connections/${view.connection.id}/capabilities/${capability.key}`, {
        enabled: capability.state !== 'on',
      });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change that');
    } finally {
      setBusy(null);
    }
  }

  async function disconnect(view: ProviderView) {
    if (!view.connection) return;
    setBusy(view.provider);
    setError('');
    try {
      const res = await api.del<{ note?: string }>(`/connections/${view.connection.id}`);
      if (res?.note) setError(res.note);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto w-full min-w-0 max-w-3xl space-y-4">
      <h1 className="text-xl font-semibold tracking-tight">Connections</h1>
      <p className="text-sm text-muted-foreground">
        Your own account, connected by you. An administrator can see whether a connection is working and
        can disconnect it, but cannot read what is inside it.
      </p>
      {error ? <ErrorNote>{error}</ErrorNote> : null}
      {!providers ? <p className="text-sm text-muted-foreground">Loading…</p> : null}

      {providers?.map((view) => (
        <Card key={view.provider}>
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <CardTitle>{PROVIDER_LABEL[view.provider]}</CardTitle>
            {view.connection ? (
              <Badge tone={view.connection.status === 'active' ? 'ok' : 'danger'}>
                {view.connection.status === 'active' ? 'connected' : 'needs reconnecting'}
              </Badge>
            ) : null}
          </div>

          {/* No application registered: say so, and offer nothing to press. */}
          {!view.available ? (
            <NotYet title="Not set up on this installation">
              An administrator has to register {PROVIDER_LABEL[view.provider]} application credentials before
              anyone can connect an account. Until then there is nothing to press here.
            </NotYet>
          ) : !view.connection ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                Connecting starts read-only. Anything that writes is a separate permission you turn on
                afterwards, and Josi asks {PROVIDER_LABEL[view.provider]} for it then.
              </p>
              <Button onClick={() => void connect(view.provider)} disabled={busy === view.provider}>
                {busy === view.provider ? 'Starting…' : `Connect ${PROVIDER_LABEL[view.provider]}`}
              </Button>
            </>
          ) : (
            <>
              {view.connection.account ? (
                <p className="truncate text-sm text-muted-foreground">{view.connection.account}</p>
              ) : null}
              {view.connection.errorCategory ? (
                <p className="mt-1 text-sm text-destructive">
                  {ERROR_TEXT[view.connection.errorCategory] ?? 'Something went wrong with this connection.'}
                </p>
              ) : null}

              <ul className="mt-3 space-y-3">
                {view.capabilities.map((capability) => (
                  <li key={capability.key} className="border-t border-border pt-3 first:border-0 first:pt-0">
                    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                      <span className="min-w-0 text-sm font-medium">{capability.label}</span>
                      <CapabilityControl
                        capability={capability}
                        busy={busy === capability.key}
                        onToggle={() => void toggle(view, capability)}
                      />
                    </div>
                    {/* What a write permission actually permits, before it can
                        be switched on. */}
                    {capability.kind === 'write' && capability.consequence ? (
                      <p className="mt-1 text-sm text-muted-foreground">{capability.consequence}</p>
                    ) : null}
                    {capability.adminNote ? (
                      <p className="mt-1 text-sm text-muted-foreground">{capability.adminNote}</p>
                    ) : null}
                  </li>
                ))}
              </ul>

              {/* Files. Real now — this replaces the "planned" placeholder.
                  Shown only under a live connection, because a folder is
                  mapped through a connection and read-only by scope. */}
              <CloudFolders
                provider={view.provider}
                connectionId={view.connection.id}
                capabilityOn={view.capabilities.some(
                  (c) => (c.key === 'google.drive.read' || c.key === 'microsoft.files.read') && c.state === 'on',
                )}
              />

              <div className="mt-4">
                <Button variant="secondary" onClick={() => void disconnect(view)} disabled={busy === view.provider}>
                  Disconnect
                </Button>
              </div>
            </>
          )}
        </Card>
      ))}

      <Card>
        <CardTitle>Other storage providers</CardTitle>
        <p className="text-sm text-muted-foreground">
          Google Drive and OneDrive folders can be connected above, read-only. Box and Dropbox may
          follow later; they are not available yet.
        </p>
      </Card>
      <DocumentInventory />
    </div>
  );
}

function DocumentInventory() {
  const [documents, setDocuments] = useState<Array<{ id: string; filename: string; state: string; skipReason: string | null; folder: string }>>([]);
  useEffect(() => { void api.get<{ documents: typeof documents }>('/storage/documents?limit=100').then((r) => setDocuments(r.documents)).catch(() => undefined); }, []);
  if (!documents.length) return null;
  return <Card><CardTitle>Files Josi can see</CardTitle><ul className="max-h-80 space-y-2 overflow-y-auto">
    {documents.map((document) => <li key={document.id} className="flex min-w-0 items-start justify-between gap-3 border-t border-border pt-2 first:border-0">
      <div className="min-w-0"><p className="truncate text-sm font-medium">{document.filename}</p><p className="truncate text-xs text-muted-foreground">{document.folder}</p>
      {document.skipReason ? <p className="text-xs text-destructive">Skipped: {document.skipReason.replace(/_/g, ' ')}</p> : null}</div>
      <Badge tone={document.state === 'indexed' ? 'ok' : 'muted'}>{plain('document_state', document.state)}</Badge>
    </li>)}
  </ul></Card>;
}

function CapabilityControl({
  capability, busy, onToggle,
}: { capability: Capability; busy: boolean; onToggle: () => void }) {
  // An administrator has switched this off installation-wide. Nothing to press:
  // a disabled control would imply the person could change it.
  if (capability.state === 'blocked_by_admin') {
    return <Badge>switched off by an administrator</Badge>;
  }
  if (capability.needsConsent) {
    return (
      <Button variant="secondary" onClick={onToggle} disabled={busy}>
        {busy ? 'Starting…' : 'Approve at provider'}
      </Button>
    );
  }
  return (
    <Button
      variant={capability.state === 'on' ? 'primary' : 'secondary'}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={capability.state === 'on'}
    >
      {capability.state === 'on' ? 'On' : 'Off'}
    </Button>
  );
}

function handshakeError(reason: string): string {
  switch (reason) {
    case 'declined':
      return 'You cancelled at the provider, so nothing was connected.';
    case 'consumed':
    case 'unknown':
    case 'expired':
      return 'That sign-in link had already been used or had expired. Start again.';
    case 'session_mismatch':
      return 'That sign-in was started in a different browser session. Start again here.';
    case 'wrong_provider':
      return 'That sign-in did not match the provider it was started for.';
    case 'revoked':
      return 'The provider refused the connection. Check the application credentials with your administrator.';
    default:
      return 'The connection could not be completed. Please try again.';
  }
}
