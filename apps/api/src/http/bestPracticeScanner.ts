export type PracticeStatus = 'pass' | 'warning' | 'fail';

export interface PracticeCheck {
  key: string;
  title: string;
  status: PracticeStatus;
  required: boolean;
  summary: string;
  impact: string;
  helpUrl: string;
  settingsUrl: string | null;
  evidence: string;
}

export interface PracticeFacts {
  masterKeyBackedUp: boolean;
  completedBackups: number;
  enabledBackupDestinations: number;
  verifiedRestores: number;
  publicHttps: boolean;
  modelVerification: 'passed' | 'failed' | 'skipped' | null;
  mailVerification: 'passed' | 'failed' | 'skipped' | null;
  securityReviewed: boolean;
  approvalPolicySet: boolean;
  unacknowledgedPolicyChanges: number;
  storagePolicyPresent: boolean;
  storageLimitsValid: boolean;
  enabledIntegrations: number;
  unhealthyIntegrations: number;
}

const DOCS = 'https://josi-ce-docs.netlify.app/';

export function buildBestPracticeScan(f: PracticeFacts): {
  scannedAt: string;
  counts: Record<PracticeStatus, number>;
  checks: PracticeCheck[];
} {
  const checks: PracticeCheck[] = [];
  const add = (check: PracticeCheck) => checks.push(check);

  add({
    key: 'backup', title: 'Off-host backups', required: true,
    status: f.completedBackups > 0 && f.enabledBackupDestinations > 0 ? 'pass' : 'fail',
    summary: f.completedBackups > 0 && f.enabledBackupDestinations > 0
      ? 'A completed backup and an enabled destination were found.'
      : 'No proven off-host backup is available.',
    impact: 'Without an off-host backup, a disk or host failure can destroy the workspace and its recovery history.',
    helpUrl: `${DOCS}#backups`, settingsUrl: '/admin/backups',
    evidence: `${f.completedBackups} completed backup${f.completedBackups === 1 ? '' : 's'}; ${f.enabledBackupDestinations} enabled destination${f.enabledBackupDestinations === 1 ? '' : 's'}.`,
  });
  add({
    key: 'restore', title: 'Verified restore', required: true,
    status: f.verifiedRestores > 0 ? 'pass' : 'fail',
    summary: f.verifiedRestores > 0 ? 'At least one restore has completed successfully.' : 'No completed restore test was found.',
    impact: 'A backup is not proven recoverable until a restore succeeds.',
    helpUrl: `${DOCS}#backups`, settingsUrl: '/admin/backups',
    evidence: `${f.verifiedRestores} successful restore${f.verifiedRestores === 1 ? '' : 's'} recorded.`,
  });
  add({
    key: 'master_key', title: 'Master key stored separately', required: true,
    status: f.masterKeyBackedUp ? 'pass' : 'fail',
    summary: f.masterKeyBackedUp ? 'The administrator confirmed an external copy.' : 'No external-copy confirmation is recorded.',
    impact: 'Backups intentionally exclude the master key; without a separate copy, restored credentials cannot be decrypted.',
    helpUrl: `${DOCS}#backups`, settingsUrl: '/admin/launch',
    evidence: f.masterKeyBackedUp ? 'Administrator confirmation recorded.' : 'No confirmation recorded.',
  });
  add({
    key: 'public_https', title: 'Public HTTPS address', required: false,
    status: f.publicHttps ? 'pass' : 'warning',
    summary: f.publicHttps ? 'A public HTTPS address is configured.' : 'This installation is not proven reachable over public HTTPS.',
    impact: 'Remote access, OAuth callbacks, and webhooks may be unavailable; LAN-only use can be intentional.',
    helpUrl: `${DOCS}#deployment`, settingsUrl: '/admin/launch',
    evidence: f.publicHttps ? 'Deployment state contains a public HTTPS base.' : 'No public HTTPS base is recorded.',
  });
  add(verificationCheck('model', 'Model health', true, f.modelVerification, '/admin/model',
    'Without a tested model, Josi cannot reliably answer or execute tasks.'));
  add(verificationCheck('mail', 'Email delivery', false, f.mailVerification, '/admin/channels',
    'Invites, resets, and assistant email cannot be relied on until delivery is tested.'));

  const secure = f.securityReviewed && f.approvalPolicySet && f.unacknowledgedPolicyChanges === 0;
  add({
    key: 'security', title: 'Administrator security posture', required: true,
    status: secure ? 'pass' : 'fail',
    summary: secure ? 'The approval ceiling is current and security review is recorded.' : 'Security review or approval-policy work remains outstanding.',
    impact: 'Unreviewed or stale approval limits can permit actions beyond the administrator’s intended ceiling.',
    helpUrl: `${DOCS}#security`, settingsUrl: '/admin/policy',
    evidence: `security review ${f.securityReviewed ? 'recorded' : 'missing'}; approval policy ${f.approvalPolicySet ? 'set' : 'not set'}; ${f.unacknowledgedPolicyChanges} unacknowledged change${f.unacknowledgedPolicyChanges === 1 ? '' : 's'}.`,
  });
  add({
    key: 'storage', title: 'Storage limits', required: true,
    status: f.storagePolicyPresent && f.storageLimitsValid ? 'pass' : 'fail',
    summary: f.storagePolicyPresent && f.storageLimitsValid ? 'Positive per-file, per-person, and file-count limits are active.' : 'Storage limits are missing or invalid.',
    impact: 'Without bounded storage, one import or account can exhaust the installation.',
    helpUrl: `${DOCS}#storage`, settingsUrl: '/admin/storage',
    evidence: f.storagePolicyPresent ? (f.storageLimitsValid ? 'All required limits are positive.' : 'One or more required limits are invalid.') : 'No storage policy row was found.',
  });
  add({
    key: 'integrations', title: 'Enabled integrations', required: false,
    status: f.enabledIntegrations === 0 ? 'warning' : f.unhealthyIntegrations > 0 ? 'warning' : 'pass',
    summary: f.enabledIntegrations === 0 ? 'No optional integrations are enabled.'
      : f.unhealthyIntegrations > 0 ? 'One or more enabled integrations lack a successful health check.'
      : 'Every enabled integration with health evidence is healthy.',
    impact: f.enabledIntegrations === 0 ? 'Josi can still work, but it cannot reach external accounts or channels.'
      : 'An unhealthy integration can fail when a user depends on it.',
    helpUrl: `${DOCS}#developer-services`, settingsUrl: '/admin/connectors',
    evidence: `${f.enabledIntegrations} enabled; ${f.unhealthyIntegrations} unhealthy or unverified.`,
  });

  return {
    scannedAt: new Date().toISOString(),
    counts: {
      pass: checks.filter((c) => c.status === 'pass').length,
      warning: checks.filter((c) => c.status === 'warning').length,
      fail: checks.filter((c) => c.status === 'fail').length,
    },
    checks,
  };
}

function verificationCheck(
  key: string, title: string, required: boolean,
  state: PracticeFacts['modelVerification'], settingsUrl: string, impact: string,
): PracticeCheck {
  const pass = state === 'passed';
  const absent = state === null || state === 'skipped';
  return {
    key, title, required,
    status: pass ? 'pass' : required ? 'fail' : 'warning',
    summary: pass ? 'A successful live test is recorded.'
      : state === 'failed' ? 'The latest recorded live test failed.'
      : `No successful live test is recorded${absent ? '.' : ''}`,
    impact,
    helpUrl: `${DOCS}#setup`,
    settingsUrl,
    evidence: state ? `Latest verification: ${state}.` : 'No verification record found.',
  };
}
