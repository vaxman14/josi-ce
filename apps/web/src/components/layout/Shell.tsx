// The app shell: brand, navigation, and the frame every page renders inside.
//
// Mobile-first for real, not as a slogan. The layout starts at 320px — an
// iPhone SE — and grows; the sidebar appears at `lg` and below that navigation
// is a bottom bar, because a hamburger that covers the content is worse than a
// row of targets a thumb can actually reach.
//
// Nothing here is a permission check. The admin links are hidden from members
// because showing them would be noise, and every one of those routes is refused
// server-side regardless.
import { useEffect, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { api, type LlmStatus } from '@/lib/api';
import { cn } from '@/lib/cn';
import { PwaPrompts } from '@/lib/pwa';
import { Button } from '@/components/ui';
import { ErrorBoundary } from '@/components/ErrorBoundary';

const MEMBER_NAV = [
  { to: '/app', label: 'Home', end: true },
  { to: '/app/talk', label: 'Talk' },
  { to: '/app/tasks', label: 'Tasks' },
  { to: '/app/approvals', label: 'Approvals' },
  { to: '/app/conversations', label: 'Conversations' },
  { to: '/app/contacts', label: 'Contacts' },
  { to: '/app/connections', label: 'Connections' },
  // Its own entry rather than a tab inside Connections: a pasted personal
  // access token and an OAuth account are different enough that one page
  // showing both teaches people the wrong thing about what they granted.
  { to: '/app/developer-services', label: 'Developer services' },
  // Its own entry again, and for a stronger reason than the one above: this is
  // the only page where somebody hands the assistant tools that somebody else
  // wrote and described. Folding it into Connections would put a discovered
  // allowlist beside a reviewed one and imply the same thing about both.
  { to: '/app/mcp-servers', label: 'MCP servers' },
  // Read-only, and its own entry rather than a tab: a skill is not a connection
  // — it has no credential, no address and no tool — and listing it beside the
  // things that do have those would suggest it might.
  { to: '/app/skills', label: 'Skills' },
  { to: '/app/usage', label: 'Usage' },
  { to: '/app/personalization', label: 'Personalization' },
  { to: '/app/telegram', label: 'Telegram' },
  { to: '/app/channels', label: 'Channels' },
  { to: '/app/settings', label: 'Settings' },
  { to: '/app/apps', label: 'Apps' },
];

/** Family is not in MEMBER_NAV, because on almost every installation the page
 * does not exist. It is appended below only when the server answers, so an
 * installation that has not bought the module shows no trace of it — and a
 * member who is neither a parent nor a managed child is not offered a page
 * about somebody else's household. */
const FAMILY_NAV: { to: string; label: string; end?: boolean } = { to: '/app/family', label: 'Family' };

const ADMIN_NAV = [
  { to: '/admin', label: 'Overview', end: true },
  // First for as long as it matters. An administrator who dismissed the
  // first-run redirect still has to be able to find the thing they dismissed.
  { to: '/admin/launch', label: 'Getting started' },
  { to: '/admin/people', label: 'People' },
  { to: '/admin/model', label: 'Model' },
  { to: '/admin/policy', label: 'Policy' },
  { to: '/admin/storage', label: 'Storage' },
  { to: '/admin/connectors', label: 'Connectors' },
  { to: '/admin/developer-services', label: 'Developer services' },
  // Its own entry rather than a tab under Connectors: this is the only
  // connection kind where the ASSISTANT picks which request to make, and the
  // page is mostly the allowlist that constrains it.
  { to: '/admin/custom-apis', label: 'Custom API' },
  // The ceiling and the health table for the servers members connect
  // themselves. Not a place to connect one: there is no route for that.
  { to: '/admin/mcp-servers', label: 'MCP servers' },
  // The library. Its own entry for the same reason the member one is: nothing
  // installed here is a connection, and the page's whole job is reading prose
  // before it is allowed anywhere near the assistant.
  { to: '/admin/skills', label: 'Skills' },
  // The paid module's licence. Under admin because buying is installation
  // administration; the page itself is explicit that it grants no oversight.
  { to: '/admin/parental-controls', label: 'Parental Controls' },
  { to: '/admin/telegram', label: 'Telegram' },
  { to: '/admin/channels', label: 'Channels' },
  { to: '/admin/workspace', label: 'Workspace' },
];

/** The five a thumb reaches on a phone. The rest live on the Home page and in
 * the sidebar; a bottom bar with nine items is a bar with none. */
const PHONE_NAV = MEMBER_NAV.filter((i) => ['Home', 'Talk', 'Tasks', 'Approvals', 'Usage'].includes(i.label));

export function Shell() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [family, setFamily] = useState(false);

  useEffect(() => {
    void api.get<LlmStatus>('/llm/status').then(setStatus).catch(() => setStatus(null));
    // 404 means the module is not entitled, or this person is in no family.
    // Either way there is no page to link to, and this is not the control —
    // every route behind it is refused server-side regardless.
    void api.get<{ role: string }>('/parental/overview')
      .then((res) => setFamily(res.role !== 'none'))
      .catch(() => setFamily(false));
  }, [location.pathname]);

  const isAdminArea = location.pathname.startsWith('/admin');
  const memberNav = family ? [...MEMBER_NAV, FAMILY_NAV] : MEMBER_NAV;
  const nav = isAdminArea ? ADMIN_NAV : memberNav;

  return (
    <div className="flex min-h-full w-full max-w-full flex-col overflow-x-hidden">
      <header className="sticky top-0 z-30 flex min-w-0 items-center gap-3 border-b border-border bg-card px-3 py-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
        <Link to="/app" className="flex min-h-11 min-w-0 shrink items-center gap-2" aria-label="Josi home">
          <img src="/brand/josi-mark.png" alt="" width={32} height={32} className="h-8 w-8 shrink-0 rounded-lg" />
          <span className="truncate text-base font-semibold tracking-tight">Josi</span>
        </Link>

        {/* M90: the Local-only badge is persistent and visible whenever the
            mode is on. It is read from the server on every navigation, never
            cached into something that could go stale and lie. */}
        {status?.localOnly ? (
          <span
            className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-xs font-medium text-emerald-300"
            title="Only self-hosted models are permitted on this installation."
          >
            Local-only
          </span>
        ) : null}

        <div className="ml-auto flex shrink-0 items-center gap-1">
          {user?.role === 'super_admin' ? (
            <Link
              to={isAdminArea ? '/app' : '/admin'}
              className="inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium hover:bg-secondary"
            >
              {isAdminArea ? 'Workspace' : 'Admin'}
            </Link>
          ) : null}
          <Button
            variant="ghost"
            onClick={() => void signOut().then(() => navigate('/login', { replace: true }))}
          >
            Sign out
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 w-full max-w-full flex-1">
        <nav
          aria-label="Main"
          className="hidden w-56 shrink-0 border-r border-border p-3 lg:block"
        >
          <ul className="space-y-1">
            {nav.map((item) => (
              <li key={item.to}>
                <NavLink
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    cn(
                      'flex min-h-11 items-center rounded-md px-3 text-sm font-medium',
                      isActive ? 'bg-primary/15 text-primary' : 'hover:bg-secondary',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>

        {/* min-w-0 is what stops a long word or a wide table from pushing the
            whole page sideways. Without it flex children refuse to shrink. */}
        <main className="min-h-0 w-full min-w-0 flex-1 p-3 pb-24 sm:p-5 lg:pb-5">
          {/* Keyed on the path so a failure on one page does not wedge every
              page behind it. */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <nav
        aria-label="Primary"
        className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-card pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        {(isAdminArea ? ADMIN_NAV : PHONE_NAV).map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              cn(
                // min-h-14 keeps the target well over 44px even with the label.
                'flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium',
                isActive ? 'text-primary' : 'text-muted-foreground',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      {/* Install and update prompts. Inside the signed-in shell on purpose:
          nothing offers to install an app to somebody looking at a login form,
          and an update prompt is only meaningful to somebody using the app. */}
      <PwaPrompts />
    </div>
  );
}
