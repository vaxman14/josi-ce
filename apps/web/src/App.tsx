import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Shell } from '@/components/layout/Shell';
import { Login } from '@/pages/Login';
import { Setup } from '@/pages/Setup';
import { Home } from '@/pages/Home';
import { Talk } from '@/pages/Talk';
import { Tasks } from '@/pages/Tasks';
import { Approvals } from '@/pages/Approvals';
import { Conversations } from '@/pages/Conversations';
import { Contacts } from '@/pages/Contacts';
import { Connections } from '@/pages/Connections';
import { Usage } from '@/pages/Usage';
import { Settings } from '@/pages/Settings';
import { Apps } from '@/pages/Apps';
import { AdminOverview } from '@/pages/admin/Overview';
import { AdminPeople } from '@/pages/admin/People';
import { AdminModel } from '@/pages/admin/Model';
import { AdminPolicy } from '@/pages/admin/Policy';
import { AdminConnectors } from '@/pages/admin/Connectors';
import { AdminWorkspace } from '@/pages/admin/Workspace';

/** Routing is convenience, not security.
 *
 * Every admin route below is refused server-side for a member, and every
 * private resource is resolved by ownership rather than by which URL was
 * requested. This redirect exists so a member does not stare at a page of
 * failed requests — not to keep them out. */
function RequireAuth({ children, admin = false }: { children: React.ReactNode; admin?: boolean }) {
  const { user, loading } = useAuth();
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  if (admin && user.role !== 'super_admin') return <Navigate to="/app" replace />;
  return <>{children}</>;
}

/** An unconfigured installation shows the wizard and nothing else.
 *
 * The server already refuses every non-setup route with 503 before setup and
 * every setup route with 404 after it, so this is not the control — it is what
 * stops a new operator from seeing a login form for an account that does not
 * exist yet. `/api/setup/state` answering 404 means setup is done. */
function useSetupNeeded(): boolean | null {
  const [needed, setNeeded] = useState<boolean | null>(null);
  useEffect(() => {
    void fetch('/api/setup/state', { credentials: 'same-origin' })
      .then(async (res) => {
        if (res.status === 404) return setNeeded(false);
        const body = await res.json().catch(() => null);
        setNeeded(!(body as { completed?: boolean } | null)?.completed);
      })
      .catch(() => setNeeded(false));
  }, []);
  return needed;
}

export function App() {
  const setupNeeded = useSetupNeeded();
  if (setupNeeded === null) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (setupNeeded) return <Setup onDone={() => window.location.assign('/login')} />;

  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route path="/app" element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Home />} />
        <Route path="talk" element={<Talk />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="conversations" element={<Conversations />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="connections" element={<Connections />} />
        <Route path="usage" element={<Usage />} />
        <Route path="settings" element={<Settings />} />
        <Route path="apps" element={<Apps />} />
      </Route>

      <Route path="/admin" element={<RequireAuth admin><Shell /></RequireAuth>}>
        <Route index element={<AdminOverview />} />
        <Route path="people" element={<AdminPeople />} />
        <Route path="model" element={<AdminModel />} />
        <Route path="policy" element={<AdminPolicy />} />
        <Route path="connectors" element={<AdminConnectors />} />
        <Route path="workspace" element={<AdminWorkspace />} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
