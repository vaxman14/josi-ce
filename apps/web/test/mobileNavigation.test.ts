import { describe, expect, it } from 'vitest';
import { ADMIN_MENU, ALL_ADMIN_MENU, ALL_WORKSPACE_MENU, WORKSPACE_MENU, itemIsCurrent, pageTitleFor, routeMatches } from '../src/components/layout/mobileNavigation.js';
import { Flags, shows } from '../src/lib/flags.js';

const labels = (items: typeof WORKSPACE_MENU) => items.map(item => item.label);

describe('the one menu', () => {
  it('keeps every Workspace destination in the requested order', () => {
    expect(labels(ALL_WORKSPACE_MENU)).toEqual([
      'My World', 'Tasks', 'Approvals', 'Conversations', 'Calendar', 'Email / Templates', 'Contacts', 'Connections', 'Local Workspace',
      'Workflows', 'Vault', 'Usage', 'Personalization', 'Channels', 'Settings', 'Apps', 'Family',
      'Devices',
    ]);
  });

  it('keeps every Admin destination in the requested order, with the pages the list left out after it', () => {
    expect(labels(ALL_ADMIN_MENU)).toEqual([
      'Overview', 'System checkup', 'Getting started', 'People', 'Model', 'Voice Box', 'Policy', 'Storage', 'Connectors', 'Workflows',
      'Channels', 'Backups', 'Master Vault', 'Integrations', 'Custom APIs', 'Network & address', 'Parental controls', 'Workspace',
      'PC control permissions', 'Automation & Cardinal Rules', 'Hey Josi',
    ]);
  });

  it('shows what the Windows lean beta shows (Flags.cs), plus Conversations, Devices and Master Vault', () => {
    expect(labels(WORKSPACE_MENU)).toEqual([
      'My World', 'Tasks', 'Approvals', 'Conversations', 'Calendar', 'Contacts', 'Connections', 'Vault', 'Settings', 'Family', 'Devices',
    ]);
    expect(labels(ADMIN_MENU)).toEqual([
      'Overview', 'System checkup', 'People', 'Model', 'Connectors', 'Backups', 'Master Vault', 'Integrations', 'Custom APIs',
      'Network & address', 'Parental controls', 'PC control permissions', 'Automation & Cardinal Rules',
    ]);
  });

  it('mirrors the Flags.cs values', () => {
    expect(Flags).toEqual({
      Relay: false, Talk: false, Workflows: false, LocalWorkspace: true, Channels: false, Apps: false, VoiceBox: false, Policy: false,
      Integrations: true, Storage: false, WorkspaceAdmin: false, Family: true, ParentalControls: true, ExtraSections: false,
    });
    expect(shows('pc-control')).toBe(true);
    expect(shows('channels')).toBe(false);
    expect(shows('anything-unlisted')).toBe(true);
  });

  it('has no Home or Talk: chat is home', () => {
    expect(labels([...WORKSPACE_MENU, ...ADMIN_MENU])).not.toEqual(expect.arrayContaining(['Home']));
    expect(labels(WORKSPACE_MENU)).not.toContain('Talk');
    expect(WORKSPACE_MENU.some(item => item.to === '/app' || item.to === '/app/talk')).toBe(false);
  });

  it('marks what is coming soon and which tiles carry a count', () => {
    expect([...ALL_WORKSPACE_MENU, ...ALL_ADMIN_MENU].filter(item => item.soon).map(item => item.label)).toEqual([]);
    expect(WORKSPACE_MENU.filter(item => item.badge).map(item => item.label)).toEqual(['Tasks', 'Approvals']);
  });

  it('marks a destination and its nested routes current', () => {
    expect(routeMatches('/app/channels', '/app/channels')).toBe(true);
    expect(routeMatches('/app/channels/telegram', '/app/channels')).toBe(true);
    expect(routeMatches('/app/calendar', '/app/channels')).toBe(false);
  });

  it('does not light Overview up for every admin page', () => {
    const overview = ADMIN_MENU[0]!;
    expect(itemIsCurrent(overview, '/admin')).toBe(true);
    expect(itemIsCurrent(overview, '/admin/people')).toBe(false);
  });

  it('tells Connectors and Integrations apart, which are one route', () => {
    const connectors = ADMIN_MENU.find(item => item.label === 'Connectors')!, integrations = ADMIN_MENU.find(item => item.label === 'Integrations')!;
    expect(itemIsCurrent(connectors, '/admin/connectors', '')).toBe(true);
    expect(itemIsCurrent(integrations, '/admin/connectors', '')).toBe(false);
    expect(itemIsCurrent(connectors, '/admin/connectors', '?view=developer')).toBe(false);
    expect(itemIsCurrent(integrations, '/admin/connectors', '?view=developer')).toBe(true);
  });

  it('names every section page in its header row', () => {
    expect(pageTitleFor('/app/tasks')).toBe('Tasks');
    expect(pageTitleFor('/admin')).toBe('Overview');
    expect(pageTitleFor('/app/channels/telegram')).toBe('Telegram');
    expect(pageTitleFor('/admin/custom-apis')).not.toBe('Josi');
  });
});
