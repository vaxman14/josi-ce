import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('Test List 7 network and canonical address contracts', () => {
  it('labels the current-password reauthentication field and explains non-persistence', () => {
    const page = read('apps/web/src/pages/admin/Network.tsx');
    expect(page).toContain('>Admin password</label>');
    expect(page).toContain('autoComplete="current-password"');
    expect(page).toContain('placeholder="Enter your current admin password"');
    expect(page).toContain('is never saved');
  });

  it('opens the maintenance URL only after the helper readiness contract succeeds', () => {
    const helper = read('services/installer/maintenance_helper.py');
    expect(helper).toContain("'-p','0.0.0.0:8080:8080'");
    expect(helper).toContain('self.wait_ready()');
    expect(helper).toContain("urlopen('https://127.0.0.1:8080/health'");
    expect(helper).toContain("docker','rm','-f',self.name");
    expect(helper).toContain('reachable_host');
  });

  it('uses APP_URL to atomically repair deployment and workspace public metadata', () => {
    const routes = read('apps/api/src/http/connectorRoutes.ts');
    expect(routes).toContain('with changed as (');
    expect(routes).toContain("jsonb_set(settings, '{publicAddress}'");
    expect(routes).toContain('detectedOrigin: appUrl');
  });
});
