// The one menu: which pages it lists, in what order, and what each is called.
// Shell.tsx draws it; this file is plain data so the order can be tested.
//
// `extras` are pages the brief's list leaves out but the app still has. They go
// after the listed tiles, so the order asked for holds and no page is left with
// no way to reach it.
//
// `section` names the tile the way apps/windows-native/src/Flags.cs does, and
// lib/flags.ts decides whether this build shows it. The full lists stay here;
// WORKSPACE_MENU and ADMIN_MENU are what the menu draws.

import { shows } from '../../lib/flags';

export interface MenuItem {
  to: string;
  label: string;
  icon: string;
  /** Matches this exact path only, not the pages beneath it. */
  end?: boolean;
  soon?: boolean;
  /** Which count this tile shows. */
  badge?: 'tasks' | 'approvals';
  /** The Flags.cs section this tile belongs to. No section: always shown. */
  section?: string;
}

export const ALL_WORKSPACE_MENU: MenuItem[] = [
  { to: '/app/my-world', label: 'My World', icon: 'world' },
  { to: '/app/brief', label: 'Daily brief', icon: 'star' },
  { to: '/app/tasks', label: 'Tasks', icon: 'tasks', badge: 'tasks' },
  { to: '/app/approvals', label: 'Approvals', icon: 'shield', badge: 'approvals' },
  { to: '/app/conversations', label: 'Conversations', icon: 'conversations' },
  { to: '/app/calendar', label: 'Calendar', icon: 'calendar' },
  { to: '/app/email/templates', label: 'Email / Templates', icon: 'mail', section: 'templates' },
  { to: '/app/contacts', label: 'Contacts', icon: 'person' },
  { to: '/app/connections', label: 'Connections', icon: 'link' },
  { to: '/app/workspace', label: 'Local Workspace', icon: 'desktop', section: 'workspace' },
  { to: '/app/workflows', label: 'Workflows', icon: 'flow', section: 'workflows' },
  { to: '/app/vault', label: 'Vault', icon: 'lock' },
  { to: '/app/usage', label: 'Usage', icon: 'chart', section: 'usage' },
  { to: '/app/personalization', label: 'Personalization', icon: 'star', section: 'personalization' },
  { to: '/app/channels', label: 'Channels', icon: 'hash', section: 'channels' },
  { to: '/app/settings', label: 'Settings', icon: 'gear' },
  { to: '/app/apps', label: 'Apps', icon: 'grid', section: 'apps' },
  { to: '/app/family', label: 'Family', icon: 'family', section: 'family' },
  // Extra:
  { to: '/app/devices', label: 'Devices', icon: 'phone' },
  { to: '/app/feedback', label: 'Send feedback', icon: 'conversations' },
];

export const ALL_ADMIN_MENU: MenuItem[] = [
  { to: '/admin', label: 'Overview', icon: 'overview', end: true },
  { to: '/admin/diagnostics', label: 'System checkup', icon: 'pulse' },
  // An administrator who dismissed the first-run redirect still has to be able
  // to find the thing they dismissed.
  { to: '/admin/launch', label: 'Getting started', icon: 'flag', section: 'checklist' },
  { to: '/admin/people', label: 'People', icon: 'people' },
  { to: '/admin/model', label: 'Model', icon: 'chip' },
  { to: '/admin/voice-box', label: 'Voice Box', icon: 'mic', section: 'voice-box' },
  { to: '/admin/policy', label: 'Policy', icon: 'shield', section: 'policy' },
  { to: '/admin/storage', label: 'Storage', icon: 'database', section: 'storage' },
  { to: '/admin/connectors', label: 'Connectors', icon: 'plug', section: 'connectors' },
  { to: '/admin/workflows', label: 'Workflows', icon: 'flow', section: 'workflow-providers' },
  { to: '/admin/channels', label: 'Channels', icon: 'hash', section: 'channels' },
  { to: '/admin/backups', label: 'Backups', icon: 'backup' },
  { to: '/admin/vault', label: 'Master Vault', icon: 'lock' },
  // One page with Connectors since October 2026 (item 41): this route redirects there.
  { to: '/admin/integrations', label: 'Integrations', icon: 'grid', section: 'integrations' },
  { to: '/admin/custom-apis', label: 'Custom APIs', icon: 'code', section: 'custom-apis' },
  { to: '/admin/network', label: 'Network & address', icon: 'globe' },
  { to: '/admin/parental-controls', label: 'Parental controls', icon: 'kid', section: 'parental' },
  { to: '/admin/workspace', label: 'Workspace', icon: 'desktop', section: 'workspace' },
  // Extras:
  { to: '/admin/pc-control', label: 'PC control permissions', icon: 'desktop', section: 'pc-control' },
  { to: '/admin/automation', label: 'Automation & Cardinal Rules', icon: 'flow', section: 'automation' },
  { to: '/admin/hey-josi', label: 'Hey Josi', icon: 'globe', section: 'relay' },
];

/** What this build's menu draws: the lists above through lib/flags.ts. */
export const WORKSPACE_MENU: MenuItem[] = ALL_WORKSPACE_MENU.filter(item => shows(item.section));
export const ADMIN_MENU: MenuItem[] = ALL_ADMIN_MENU.filter(item => shows(item.section));

/** False for a page this build hides (its route sends it to chat). */
export function pathShown(pathname: string): boolean {
  return ![...ALL_WORKSPACE_MENU, ...ALL_ADMIN_MENU].some(item => !shows(item.section) && routeMatches(pathname, item.to));
}

/** Pages with no tile of their own, reached from a page that has one. */
const OTHER_TITLES: Record<string, string> = {
  '/app/channels/telegram': 'Telegram',
  '/admin/telegram': 'Telegram',
};

export function routeMatches(pathname: string, destination: string) {
  return pathname === destination || pathname.startsWith(`${destination}/`);
}

/** Is this tile the page being looked at? Connectors and Integrations are one
 * route, told apart by the view it opens on. */
export function itemIsCurrent(item: MenuItem, pathname: string, search = ''): boolean {
  const developerView = new URLSearchParams(search).get('view') === 'developer';
  if (item.to === '/admin/integrations') return pathname === '/admin/connectors' && developerView;
  if (item.to === '/admin/connectors' && developerView) return false;
  return item.end ? pathname === item.to : routeMatches(pathname, item.to);
}

/** The title in a section page's header row. */
export function pageTitleFor(pathname: string): string {
  if (OTHER_TITLES[pathname]) return OTHER_TITLES[pathname];
  const items = [...WORKSPACE_MENU, ...ADMIN_MENU];
  return items.find(item => itemIsCurrent(item, pathname))?.label ?? 'Josi';
}
