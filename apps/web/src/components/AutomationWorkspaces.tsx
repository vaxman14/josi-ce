import { useEffect, useState } from 'react';
import type { AutomationWorkspaceSummary } from '@josi-ce/core';
import { api } from '@/lib/api';

/** Discovery only. A displayed connection is never a permission or a lease. */
export function AutomationWorkspaces() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ available: boolean; workspaces: AutomationWorkspaceSummary[] } | null>(null);
  const [error, setError] = useState('');
  const [received, setReceived] = useState<Date | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true, pending = false;
    async function load() {
      if (!alive || pending || document.hidden) return;
      pending = true;
      try {
        const result = await api.get<{ available: boolean; workspaces: AutomationWorkspaceSummary[] }>('/assistant/automation/workspaces');
        if (alive) { setStatus(result); setError(''); setReceived(new Date()); }
      } catch { if (alive) setError('Automation connections could not refresh. Their current state is unavailable.'); }
      finally { pending = false; }
    }
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', visible);
    return () => { alive = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [open]);
  const labels = { ready: 'Ready for permission-checked work', paused: 'Paused',
    needs_local_consent: 'Waiting for the device owner', offline: 'Offline' };
  return <details className="rounded-xl border border-border bg-card p-4" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium">Automation desktops</summary>
    <p className="mt-2 text-sm text-muted-foreground">Separate desktops and dedicated browsers available to your work.</p>
    {error ? <p className="mt-3 text-sm text-destructive" role="status">{error}</p>
      : !status ? <p className="mt-3 text-sm text-muted-foreground">Loading connections…</p>
        : !status.available ? <p className="mt-3 text-sm">Automation control is not available on this server yet. Your other Josi work can continue.</p>
          : !status.workspaces.length ? <p className="mt-3 text-sm">No automation desktop is connected to your account.</p>
            : <ul className="mt-3 space-y-3">{status.workspaces.map(workspace => <li key={workspace.identity.workspaceId} className="rounded-lg border border-border p-3">
              <p className="font-medium">{workspace.label}</p>
              <p className="mt-1 text-sm">{labels[workspace.state]}</p>
              <p className="mt-1 text-xs text-muted-foreground">{[
                workspace.browserFamilies.length ? `Browsers: ${workspace.browserFamilies.join(', ')}` : null,
                workspace.computerUse ? 'Computer control supported' : null,
              ].filter(Boolean).join(' · ') || 'No control adapter is currently available.'}</p>
            </li>)}</ul>}
    {received ? <p className="mt-3 text-xs text-muted-foreground">Last checked {received.toLocaleTimeString()}. Each action still checks current access.</p> : null}
  </details>;
}
