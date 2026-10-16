import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { doctorCheckDestination, orderDoctorChecks } from '../src/lib/doctorChecks.js';
import { Diagnosis, NativeMacRecovery, type DoctorDiagnosis } from '../src/pages/admin/Diagnostics.js';

describe('Josi Doctor checkup navigation', () => {
  it('routes native failures to their actual Mac settings and explains the native repair path', () => {
    expect(doctorCheckDestination('native_voice').to).toBe('/admin/voice-box');
    expect(doctorCheckDestination('native_workspace').to).toBe('/app/workspace');
    expect(doctorCheckDestination('native_backup_history').to).toBe('/admin/backups');
    const html = renderToStaticMarkup(React.createElement(NativeMacRecovery));
    expect(html).toContain('Josi Server app');
    expect(html).toContain('signed Josi installer');
    expect(html).not.toContain('Docker');
  });
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
