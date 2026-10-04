import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { doctorCheckDestination, orderDoctorChecks } from '../src/lib/doctorChecks.js';
import { Diagnosis, type DoctorDiagnosis } from '../src/pages/admin/Diagnostics.js';

describe('Josi Doctor checkup navigation', () => {
  it('moves failures to the top while preserving order within each state', () => {
    const checks = [
      { key: 'runtime', state: 'pass' as const },
      { key: 'backup_receipt', state: 'warn' as const },
      { key: 'public_health', state: 'fail' as const },
      { key: 'disk', state: 'fail' as const },
      { key: 'architecture', state: 'pass' as const },
    ];

    expect(orderDoctorChecks(checks).map((check) => check.key)).toEqual([
      'public_health', 'disk', 'backup_receipt', 'runtime', 'architecture',
    ]);
  });

  it('sends actionable failures to the relevant settings page', () => {
    expect(doctorCheckDestination('disk')).toEqual({ to: '/admin/storage', action: 'Open storage settings' });
    expect(doctorCheckDestination('domain_dns')).toEqual({ to: '/admin/network', action: 'Open network settings' });
    expect(doctorCheckDestination('workspace')).toEqual({ to: '/app/workspace', action: 'Open Local Workspace' });
    expect(doctorCheckDestination('backup_integrity')).toEqual({ to: '/admin/backups', action: 'Open backup settings' });
    expect(doctorCheckDestination('push_delivery')).toEqual({ to: '/admin/channels', action: 'Open channel settings' });
  });

  it('keeps operational failures on Doctor repair controls', () => {
    expect(doctorCheckDestination('container_worker')).toEqual({
      to: '/admin/diagnostics#doctor-actions',
      action: 'Review repair options',
    });
  });

  it('renders red failures first as links and collapses the remaining checks', () => {
    const diagnosis: DoctorDiagnosis = {
      checkedAt: '2026-10-04T02:00:00Z', healthy: false, safeRepairAvailable: false,
      failed: ['domain_dns'], fingerprint: 'test',
      checks: [
        { key: 'architecture', label: 'Architecture', state: 'pass', detail: 'amd64' },
        { key: 'domain_dns', label: 'Domain DNS', state: 'fail', detail: 'cannot resolve example.test' },
        { key: 'backup_receipt', label: 'Backup receipt', state: 'warn', detail: 'none yet' },
      ],
    };
    const html = renderToStaticMarkup(React.createElement(MemoryRouter, null,
      React.createElement(Diagnosis, { value: diagnosis })));

    expect(html.indexOf('Domain DNS')).toBeLessThan(html.indexOf('Architecture'));
    expect(html).toContain('href="/admin/network"');
    expect(html).toContain('Checks needing repair');
    expect(html).toContain('<details class="mt-3 rounded-md border border-border">');
    expect(html).toContain('2 other checks');
  });
});
