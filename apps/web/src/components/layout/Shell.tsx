// The app shell: one bar across the top, the page, and one menu.
//
// Chat is the home screen. There is no sidebar and no phone bottom bar: every
// page is reached from the menu at the top right, on every screen size. The bar
// is one element whether it is showing the chat's "Josi / online" or a section
// page's back arrow and title, so the menu button is the same button everywhere
// and focus can always go back to it.
//
// Mobile-first for real, not as a slogan. The layout starts at 320px, an iPhone
// SE, and grows.
//
// Nothing here is a permission check. The admin tiles are hidden from members
// because showing them would be noise, and every one of those routes is refused
// server-side regardless.
import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '@/lib/auth';
import { api, type Approval, type LlmStatus, type Task } from '@/lib/api';
import { watchApprovals, type ApprovalSnapshot } from '@/lib/approvalRefresh';
import { PwaPrompts } from '@/lib/pwa';
import { CrashReportPrompt } from '@/components/CrashReportPrompt';
import { syncSkin } from '@/lib/skin';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { JosiMark } from '@/components/brand/JosiMark';
import { HELP_URL, LIVE_HELP_URL, LegalLinks } from '@/components/LegalLinks';
import { Icon } from './Icon';
import { ADMIN_MENU, WORKSPACE_MENU, itemIsCurrent, pageTitleFor, type MenuItem } from './mobileNavigation';

/** What the chat's status line says. Talk owns it; the bar only shows it. */
export type ChatStatus = 'online' | 'listening' | 'thinking' | 'speaking';

/** What the shell hands the page inside it, so there is one approvals poll.
 * The chat also gets its status line and a slot in the bar, beside the menu,
 * for the History button and the task pill. */
export interface ShellOutlet {
  approvals: Approval[];
  setChatStatus: (status: ChatStatus) => void;
  chatBarSlot: HTMLElement | null;
}

const roleLabel = (role?: string) => role === 'super_admin' ? 'Owner' : 'Member';

function CountBadge({ count, className = '' }: { count: number; className?: string }) {
  if (!count) return null;
  return <span className={`absolute flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full bg-badge px-1 text-[0.65rem] font-semibold leading-none text-badge-foreground ${className}`}>{count > 99 ? '99+' : count}</span>;
}

function Tile({ item, count, pathname, search, onPick }: { item: MenuItem; count: number; pathname: string; search: string; onPick: () => void }) {
  const current = itemIsCurrent(item, pathname, search);
  return (
    <li>
      <Link to={item.to} onClick={onPick} aria-current={current ? 'page' : undefined} className={`menu-tile ${item.soon ? 'menu-tile-soon' : ''}`}>
        <Icon name={item.icon} />
        <span>{item.label}</span>
        {item.soon ? <span className="text-[0.62rem] text-lilac">Coming soon</span> : null}
        <CountBadge count={count} className="right-1 top-1" />
      </Link>
    </li>
  );
}

function Menu({ onClose, counts, status }: { onClose: () => void; counts: Record<'tasks' | 'approvals', number>; status: LlmStatus | null }) {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const sheet = useRef<HTMLDivElement>(null);
  const name = user?.displayName || user?.display_name || user?.username || '';
  const doSignOut = () => void signOut().then(() => navigate('/login', { replace: true }));

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusables = () => Array.from(sheet.current?.querySelectorAll<HTMLElement>('a[href], button') ?? []);
    const frame = window.requestAnimationFrame(() => {
      (sheet.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? focusables()[0])?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab') return;
      const all = focusables();
      if (!all.length) return;
      const first = all[0]!, last = all[all.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const tiles = (items: MenuItem[]) => (
    <ul className="grid grid-cols-2 gap-2 min-[340px]:grid-cols-3 min-[430px]:grid-cols-4">
      {items.map(item => <Tile key={item.to} item={item} count={item.badge ? counts[item.badge] : 0} pathname={pathname} search={search} onPick={onClose} />)}
    </ul>
  );

  return (
    <div className="fixed inset-0 z-40" style={{ background: 'var(--scrim)' }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div
        ref={sheet}
        id="app-menu"
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        className="menu-sheet absolute inset-0 overflow-y-auto overscroll-contain bg-card p-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-[max(1rem,env(safe-area-inset-top))] sm:inset-auto sm:right-3 sm:top-3 sm:max-h-[calc(100dvh-1.5rem)] sm:w-[420px] sm:rounded-[18px] sm:border sm:border-[color:var(--hairline-strong)] sm:shadow-2xl"
      >
        <div className="flex items-center gap-3 rounded-lg border border-[color:var(--hairline)] bg-primary/5 p-3">
          <span aria-hidden className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-secondary font-display text-base font-bold text-primary">{(name[0] ?? '?').toUpperCase()}</span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="truncate text-xs text-lilac">{user?.email}</p>
            <p className="truncate text-xs text-text-muted">{roleLabel(user?.role)}</p>
          </div>
          <button type="button" aria-label="Close menu" onClick={onClose} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-2xl leading-none text-primary hover:bg-secondary">×</button>
        </div>
        {status?.localOnly ? <p className="mt-2 text-xs text-text-muted">Local-only: only self-hosted models are permitted on this installation.</p> : null}

        <nav aria-label="Pages" className="mt-4">
          <h2 className="mb-2 px-1 text-[0.95rem]">Workspace</h2>
          {tiles(WORKSPACE_MENU)}
          {user?.role === 'super_admin' ? <>
            <h2 className="mb-2 mt-5 flex items-center gap-2 px-1 text-[0.95rem]">Admin <span className="btn-gold rounded-full px-2 py-px font-sans text-[0.65rem] font-semibold">Owner</span></h2>
            {tiles(ADMIN_MENU)}
          </> : null}
        </nav>

        <ul className="mt-5 grid grid-cols-3 gap-2 text-center text-xs font-medium">
          <li><a href={HELP_URL} target="_blank" rel="noreferrer noopener" className="flex min-h-11 items-center justify-center rounded-lg border border-border px-1 hover:border-primary/60">Help</a></li>
          <li><a href={LIVE_HELP_URL} target="_blank" rel="noreferrer noopener" className="flex min-h-11 items-center justify-center rounded-lg border border-border px-1 hover:border-primary/60">Live Help chat</a></li>
          <li><button type="button" onClick={doSignOut} className="min-h-11 w-full rounded-lg border border-destructive/40 px-1 text-destructive hover:border-destructive">Sign out</button></li>
        </ul>
        <LegalLinks className="mt-4 flex flex-wrap justify-center gap-x-3 gap-y-1 text-xs text-text-muted [&_a]:underline" />
      </div>
    </div>
  );
}

export function Shell() {
  const { user } = useAuth();
  const location = useLocation();
  const [status, setStatus] = useState<LlmStatus | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [counts, setCounts] = useState({ tasks: 0, approvals: 0 });
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [chatStatus, setChatStatus] = useState<ChatStatus>('online');
  const [chatBarSlot, setChatBarSlot] = useState<HTMLElement | null>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMenu = useRef(() => { setMenuOpen(false); menuButton.current?.focus(); }).current;

  useEffect(() => {
    void api.get<LlmStatus>('/llm/status').then(setStatus).catch(() => setStatus(null));
    void api.get<{ tasks: Task[] }>('/assistant/tasks').then(r => setCounts(c => ({ ...c, tasks: r.tasks.length }))).catch(() => undefined);
  }, [location.pathname]);

  useEffect(() => { void syncSkin(); }, [user?.id]);

  useEffect(() => watchApprovals(
    () => api.get<ApprovalSnapshot<Approval>>('/assistant/approvals'),
    snapshot => { setApprovals(snapshot.approvals); setCounts(c => ({ ...c, approvals: snapshot.count })); },
  ), []);

  const isChat = location.pathname.replace(/\/$/, '') === '/app';
  const waiting = counts.tasks + counts.approvals;

  return (
    <div className="flex h-dvh w-full max-w-full flex-col overflow-hidden">
      <header className="frost hairline-b z-30 flex min-w-0 shrink-0 items-center gap-2 px-3 pb-2 pt-[max(0.5rem,env(safe-area-inset-top))] sm:px-4">
        {isChat ? (
          <div className="flex min-h-11 min-w-0 items-center gap-2.5">
            <JosiMark size={28} />
            <span className="truncate font-display text-lg font-bold">Josi</span>
            <span className={`flex shrink-0 items-center gap-1 text-xs transition-colors ${chatStatus === 'online' ? 'text-lilac' : 'text-primary'}`}>
              <span aria-hidden className={`h-2 w-2 rounded-full ${chatStatus === 'online' ? 'bg-success' : chatStatus === 'listening' ? 'stage-dot-listening' : 'bg-primary'}`} />
              {chatStatus === 'online' ? 'online' : `${chatStatus}…`}
            </span>
          </div>
        ) : (
          <div className="flex min-h-11 min-w-0 items-center gap-1">
            <Link to="/app" aria-label="Back to chat" className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-primary hover:bg-secondary">
              <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
            </Link>
            <span className="truncate font-display text-base font-semibold">{pageTitleFor(location.pathname)}</span>
          </div>
        )}

        <nav aria-label="App" className="ml-auto flex shrink-0 items-center gap-2">
          {/* M90: the Local-only badge is persistent and visible whenever the
              mode is on. It is read from the server on every navigation, never
              cached into something that could go stale and lie. */}
          {status?.localOnly ? (
            <span className="shrink-0 rounded-full bg-lilac/15 px-2.5 py-0.5 text-xs font-medium text-lilac" title="Only self-hosted models are permitted on this installation.">Local-only</span>
          ) : null}
          {isChat ? <span ref={setChatBarSlot} className="flex shrink-0 items-center gap-2" /> : null}
          <button
            ref={menuButton}
            type="button"
            aria-label={waiting ? `Open menu, ${waiting} waiting` : 'Open menu'}
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            aria-controls="app-menu"
            onClick={() => setMenuOpen(true)}
            className="relative flex h-11 w-11 items-center justify-center rounded-full border border-[color:var(--hairline-strong)] bg-card/60 text-primary hover:bg-card"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 7h14M5 12h14M5 17h14" /></svg>
            <CountBadge count={waiting} className="-right-1 -top-1" />
          </button>
        </nav>
      </header>

      {/* min-w-0 is what stops a long word or a wide table from pushing the
          whole page sideways. Without it flex children refuse to shrink. */}
      <main className={`min-h-0 w-full min-w-0 flex-1 ${isChat ? 'overflow-hidden' : 'overflow-y-auto overscroll-contain p-4 sm:p-6 lg:px-8 lg:py-7'}`}>
        {/* Keyed on the path so a failure on one page does not wedge every
            page behind it. */}
        <ErrorBoundary key={location.pathname}>
          <Outlet context={{ approvals, setChatStatus, chatBarSlot } satisfies ShellOutlet} />
        </ErrorBoundary>
      </main>

      {menuOpen ? <Menu onClose={closeMenu} counts={counts} status={status} /> : null}

      {/* Install and update prompts. Inside the signed-in shell on purpose:
          nothing offers to install an app to somebody looking at a login form,
          and an update prompt is only meaningful to somebody using the app. */}
      <PwaPrompts />
      <CrashReportPrompt />
    </div>
  );
}
