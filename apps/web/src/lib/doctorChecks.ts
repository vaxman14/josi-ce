export type DoctorCheckState = 'pass' | 'warn' | 'fail';

export interface NavigableDoctorCheck {
  key: string;
  state: DoctorCheckState;
}

export interface DoctorCheckDestination {
  to: string;
  action: string;
}

const CHECK_DESTINATIONS: Record<string, DoctorCheckDestination> = {
  disk: { to: '/admin/storage', action: 'Open storage settings' },
  writable_data: { to: '/admin/storage', action: 'Open storage settings' },
  public_health: { to: '/admin/network', action: 'Open network settings' },
  domain_dns: { to: '/admin/network', action: 'Open network settings' },
  port_collision_http: { to: '/admin/network', action: 'Open network settings' },
  port_collision_https: { to: '/admin/network', action: 'Open network settings' },
  workspace: { to: '/admin/workspace', action: 'Open workspace settings' },
  backup_integrity: { to: '/admin/backups', action: 'Open backup settings' },
  backup_receipt: { to: '/admin/backups', action: 'Open backup settings' },
  push_delivery: { to: '/admin/channels', action: 'Open channel settings' },
};

const REPAIR_DESTINATION: DoctorCheckDestination = {
  to: '/admin/diagnostics#doctor-actions',
  action: 'Review repair options',
};

export function doctorCheckDestination(key: string): DoctorCheckDestination {
  return CHECK_DESTINATIONS[key] ?? REPAIR_DESTINATION;
}

const STATE_PRIORITY: Record<DoctorCheckState, number> = { fail: 0, warn: 1, pass: 2 };

/** Failures must be impossible to bury below a long list of healthy checks.
 * Preserve the helper's order within each state so repeated runs do not make
 * otherwise unchanged rows jump around. */
export function orderDoctorChecks<T extends NavigableDoctorCheck>(checks: T[]): T[] {
  return checks
    .map((check, index) => ({ check, index }))
    .sort((a, b) => STATE_PRIORITY[a.check.state] - STATE_PRIORITY[b.check.state] || a.index - b.index)
    .map(({ check }) => check);
}
