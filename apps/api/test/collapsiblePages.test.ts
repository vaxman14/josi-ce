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

  it('preserves the established Connectors-style disclosures on Channels', () => {
    const channels = read('apps/web/src/pages/Channels.tsx');
    expect(channels).toContain('<details>');
    expect(channels).toContain('<summary');
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
