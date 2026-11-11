import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('compact settings disclosures', () => {
  it('uses the browser-native accessible disclosure contract', () => {
    const ui = read('apps/web/src/components/ui/index.tsx');
    expect(ui).toContain('export function CollapsibleCard');
    expect(ui).toContain('<details');
    expect(ui).toContain('<summary');
    expect(ui).toContain('focus-visible:ring-2');
    expect(ui).toContain('min-h-11');
  });

  it.each([
    'pages/Connections.tsx',
    'pages/Personalization.tsx',
    'pages/Settings.tsx',
    'pages/Usage.tsx',
    'pages/admin/Model.tsx',
    'pages/admin/ParentalControls.tsx',
    'pages/admin/Policy.tsx',
    'pages/admin/LaunchChecklist.tsx',
    'pages/admin/Storage.tsx',
    'pages/admin/Telegram.tsx',
  ])('uses compact disclosures on %s', (page) => {
    expect(read(`apps/web/src/${page}`)).toContain('CollapsibleCard');
  });

  it('keeps checkup state and remediation visible and actionable', () => {
    const overview = read('apps/web/src/pages/admin/Overview.tsx');
    for (const label of ['Working', 'Needs attention', 'Unavailable', 'Not configured', 'Check again', 'Last checked']) {
      expect(overview).toContain(label);
    }
    expect(overview).toContain('Recommendations');
    expect(overview).toContain('navigate(item.href)');
  });

  it('shows effective approval policy locks and removes choices the server would ignore',()=>{
    const settings=read('apps/web/src/pages/Settings.tsx');
    expect(settings).toContain('Managed policy lock');
    expect(settings).toContain('Choices this lock would ignore are not offered');
    expect(settings).toContain('LEVEL_RANK[level.value] <= LEVEL_RANK[state.adminCeiling!]');
    const admin=read('apps/web/src/pages/admin/Policy.tsx');
    expect(admin).toContain('No managed limits');
    expect(admin).toContain('exists only after you set');
  });

  it('shows the real Family and Parental controls pages, with the beta warning', () => {
    const menu = read('apps/web/src/components/layout/mobileNavigation.ts');
    const admin = read('apps/web/src/pages/admin/ParentalControls.tsx');
    const family = read('apps/web/src/pages/Family.tsx');
    expect(menu).not.toMatch(/label: 'Family'.*soon: true/);
    expect(menu).not.toMatch(/label: 'Parental controls'.*soon: true/);
    expect(family).toContain("api.get<Overview>('/parental/overview')");
    expect(family).toContain('do not rely on these controls for a child');
    expect(family).not.toContain('Coming Soon');
    expect(admin).not.toContain('Coming Soon');
  });

  it('makes every developer service an accessible disclosure', () => {
    const page = read('apps/web/src/pages/admin/DeveloperServices.tsx');
    expect(page).toContain('CollapsibleCard');
    expect(page).toContain('defaultOpen={needsAttention}');
    expect(page).toContain('Needs attention');
  });

  it('preserves the established Connectors-style disclosures on Channels', () => {
    const channels = read('apps/web/src/pages/Channels.tsx');
    expect(channels).toContain('<details>');
    expect(channels).toContain('<summary');
  });

  it('keeps Telegram beside every existing admin channel', () => {
    const channels = read('apps/web/src/pages/admin/Channels.tsx');
    expect(channels).toContain('to="/admin/telegram"');
    expect(channels).toContain("['whatsapp','slack']");
  });

  it('binds backup destination styling and actions to one controlled selection', () => {
    const backups = read('apps/web/src/pages/admin/Backups.tsx');
    expect(backups).toContain('checked={selected}');
    expect(backups).toContain('setKind(c.kind)');
    expect(backups).toContain('aria-label="Selected"');
  });

  it.each([
    'pages/Login.tsx',
    'pages/Setup.tsx',
    'pages/Talk.tsx',
    'pages/Tasks.tsx',
  ])('keeps primary workflow content visible on %s', (page) => {
    expect(read(`apps/web/src/${page}`)).not.toContain('CollapsibleCard');
  });
});
