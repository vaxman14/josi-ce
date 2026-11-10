import { EmailTemplates } from './pages/EmailTemplates';
import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { Shell } from '@/components/layout/Shell';
import { Login } from '@/pages/Login';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { SetPassword } from '@/pages/SetPassword';
import { Setup } from '@/pages/Setup';
import { Talk } from '@/pages/Talk';
import { Tasks } from '@/pages/Tasks';
import { Approvals } from '@/pages/Approvals';
import { Conversations } from '@/pages/Conversations';
import { Contacts } from '@/pages/Contacts';
import { Connections } from '@/pages/Connections';
import { Workflows } from '@/pages/Workflows';
import { LocalWorkspace } from '@/pages/LocalWorkspace';
import { Calendar } from '@/pages/Calendar';
import { Vault } from '@/pages/Vault';
import { Usage } from '@/pages/Usage';
import { Personalization } from '@/pages/Personalization';
import { Settings } from '@/pages/Settings';
import { Telegram } from '@/pages/Telegram';
import { Channels } from '@/pages/Channels';
import { Apps } from '@/pages/Apps';
import { Family } from '@/pages/Family';
import { AdminOverview } from '@/pages/admin/Overview';
import { AdminDiagnostics } from '@/pages/admin/Diagnostics';
import { AdminPeople } from '@/pages/admin/People';
import { AdminModel } from '@/pages/admin/Model';
import { AdminPolicy } from '@/pages/admin/Policy';
import { AdminPcControl } from '@/pages/admin/PcControl';
import { AdminStorage } from '@/pages/admin/Storage';
import { AdminConnectorsHub } from '@/pages/admin/ConnectorsHub';
import { AdminWorkflows } from '@/pages/admin/Workflows';
import { AdminWorkspace } from '@/pages/admin/Workspace';
import { AdminTelegram } from '@/pages/admin/Telegram';
import { AdminBackups } from '@/pages/admin/Backups';
import { AdminCustomApis } from '@/pages/admin/CustomApis';
import { AdminParentalControls } from '@/pages/admin/ParentalControls';
import { AdminLaunchChecklist } from '@/pages/admin/LaunchChecklist';
import { AdminVoiceBox } from '@/pages/admin/VoiceBox';
import { AdminChannels } from '@/pages/admin/Channels';
import { AdminVault } from '@/pages/admin/Vault';
import { AdminAutomation } from '@/pages/admin/Automation';
import { AdminNetwork } from '@/pages/admin/Network';
import { AdminHeyJosi } from '@/pages/admin/HeyJosi';
import { Devices } from '@/pages/Devices';
import { api } from '@/lib/api';
import { shows } from '@/lib/flags';
import { MyWorld } from '@/pages/MyWorld';

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

/** Chat is /app now. Anything pointing at the old address, a bookmark or a link
 * in an old email, lands there with the conversation it asked for. */
/** A section this build hides (lib/flags.ts, mirroring Flags.cs) lands on
 * chat. The page stays in the source and comes back with its flag. */
function shown(section: string, page: React.ReactNode): React.ReactNode {
  return shows(section) ? page : <Navigate to="/app" replace />;
}

function TalkRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/app${search}`} replace />;
}

/** First-run routing for the person who installed this.
 *
 * Setup finishing and the installation being ready to use are different
 * things, and the gap was invisible: the super admin landed on the ordinary
 * user dashboard with no sign that nobody had been invited, no backup existed,
 * and the master key had never left the server.
 *
 * So the first sign-in after setup goes to the checklist instead. Exactly once
 * — the checklist records that it has been seen, and after that ordinary
 * role-aware routing takes over. It is a convenience, not a control: nothing
 * here grants or refuses anything.
 *
 * HOW it redirects matters (round-2 item 10). This used to hand a target back
 * to App, which then returned a bare <Navigate> in place of the whole route
 * tree — and kept returning it, because nothing ever cleared the target. Once
 * the URL reached /admin/launch, <Navigate> rendered null and the first
 * sign-in after setup was a BLANK PAGE until a manual refresh rebuilt the
 * state. The redirect is now imperative and fired at most once; the route
 * tree always renders, so no state combination can blank the screen.
 */
function useFirstRunRedirect(): void {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const redirected = useRef(false);

  useEffect(() => {
    // A build without the checklist (lib/flags.ts) has nowhere to send them.
    if (!shows('checklist') || loading || user?.role !== 'super_admin' || redirected.current) return;
    // Already there, or deliberately somewhere else in the admin section.
    if (window.location.pathname.startsWith('/admin')) return;
    void fetch('/api/admin/launch-checklist', { credentials: 'same-origin', cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) return;
        const body = await res.json().catch(() => null) as { seen?: boolean } | null;
        if (body && body.seen === false && !redirected.current) {
          redirected.current = true;
          navigate('/admin/launch', { replace: true });
        }
      })
      .catch(() => undefined);
  }, [loading, user?.role, navigate]);
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
    // `cache: 'no-store'` for the same reason as lib/api.ts: a cached
    // permanent redirect must not be replayed here.
    void api.get<{ completed: boolean }>('/setup/state')
      .then((body) => setNeeded(!body.completed))
      .catch((error) => setNeeded(error?.status === 404 ? false : true));
  }, []);
  return needed;
}

export function App() {
  const setupNeeded = useSetupNeeded();
  useFirstRunRedirect();
  if (setupNeeded === null) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (setupNeeded) return <Setup onDone={() => window.location.replace('/login?setup=complete')} />;

  // Everything below always renders a page. Redirects are either declared
  // inside the route tree (so the tree keeps rendering) or fired imperatively
  // above — App never substitutes a bare, null-rendering element for the
  // whole tree. That substitution is exactly what blanked the first
  // post-setup sign-in.
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/set-password" element={<SetPassword />} />

      <Route path="/app" element={<RequireAuth><Shell /></RequireAuth>}>
        <Route index element={<Talk />} />
        <Route path="my-world" element={<MyWorld />} />
        <Route path="talk" element={<TalkRedirect />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="approvals" element={<Approvals />} />
        <Route path="conversations" element={<Conversations />} />
        <Route path="contacts" element={<Contacts />} />
        <Route path="connections" element={<Connections />} />
        <Route path="workflows" element={shown('workflows', <Workflows />)} />
        <Route path="calendar" element={<Calendar />} />
        <Route path="email/templates" element={shown('templates', <EmailTemplates />)} />
        <Route path="workspace" element={shown('workspace', <LocalWorkspace />)} />
        <Route path="vault" element={<Vault />} />
        <Route path="usage" element={shown('usage', <Usage />)} />
        <Route path="devices" element={<Devices />} />
        <Route path="personalization" element={shown('personalization', <Personalization />)} />
        <Route path="settings" element={<Settings />} />
        <Route path="channels" element={shown('channels', <Channels />)} />
        <Route path="channels/telegram" element={shown('channels', <Telegram />)} />
        {/* Telegram was a top-level item before it was a channel. Anything
            already pointing at the old path — a bookmark, a link in an old
            email — lands where the page lives now rather than on the
            catch-all redirect to chat. */}
        <Route path="telegram" element={<Navigate to="/app/channels/telegram" replace />} />
        <Route path="apps" element={shown('apps', <Apps />)} />
        <Route path="family" element={shown('family', <Family />)} />
      </Route>

      <Route path="/admin" element={<RequireAuth admin><Shell /></RequireAuth>}>
        <Route index element={<AdminOverview />} />
        <Route path="diagnostics" element={<AdminDiagnostics />} />
        <Route path="people" element={<AdminPeople />} />
        <Route path="model" element={<AdminModel />} />
        <Route path="voice-box" element={shown('voice-box', <AdminVoiceBox />)} />
        <Route path="policy" element={shown('policy', <AdminPolicy />)} />
        <Route path="pc-control" element={shown('pc-control', <AdminPcControl />)} />
        <Route path="storage" element={shown('storage', <AdminStorage />)} />
        <Route path="connectors" element={shown('connectors', <AdminConnectorsHub />)} />
        <Route path="workflows" element={shown('workflow-providers', <AdminWorkflows />)} />
        <Route path="channels" element={shown('channels', <AdminChannels />)} />
        <Route path="workspace" element={shown('workspace', <AdminWorkspace />)} />
        <Route path="telegram" element={shown('channels', <AdminTelegram />)} />
        <Route path="backups" element={<AdminBackups />} />
        <Route path="vault" element={<AdminVault />} />
        <Route path="automation" element={shown('automation', <AdminAutomation />)} />
        <Route path="network" element={<AdminNetwork />} />
        <Route path="hey-josi" element={shown('relay', <AdminHeyJosi />)} />
        {/* Connectors and Integrations are one page since October 2026 (item 41). */}
        <Route path="developer-services" element={<Navigate to="/admin/connectors?view=developer" replace />} />
        <Route path="integrations" element={<Navigate to="/admin/connectors?view=developer" replace />} />
        <Route path="custom-apis" element={shown('custom-apis', <AdminCustomApis />)} />
        <Route path="parental-controls" element={shown('parental', <AdminParentalControls />)} />
        <Route path="launch" element={shown('checklist', <AdminLaunchChecklist />)} />
      </Route>

      <Route path="*" element={<Navigate to="/app" replace />} />
    </Routes>
  );
}
