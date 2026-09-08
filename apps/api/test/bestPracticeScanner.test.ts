import { describe, expect, it } from 'vitest';
import { buildBestPracticeScan, type PracticeFacts } from '../src/http/bestPracticeScanner.js';

const healthy: PracticeFacts = {
  masterKeyBackedUp: true,
  completedBackups: 2,
  enabledBackupDestinations: 1,
  verifiedRestores: 1,
  publicHttps: true,
  modelVerification: 'passed',
  mailVerification: 'passed',
  securityReviewed: true,
  approvalPolicySet: true,
  unacknowledgedPolicyChanges: 0,
  storagePolicyPresent: true,
  storageLimitsValid: true,
  enabledIntegrations: 2,
  unhealthyIntegrations: 0,
};

describe('best-practice scanner', () => {
  it('passes only facts backed by affirmative evidence', () => {
    const scan = buildBestPracticeScan(healthy);
    expect(scan.counts).toEqual({ pass: 9, warning: 0, fail: 0 });
    expect(scan.checks.every((c) => c.evidence.length > 0)).toBe(true);
  });

  it('treats required recovery and security gaps as failures', () => {
    const scan = buildBestPracticeScan({
      ...healthy,
      masterKeyBackedUp: false,
      completedBackups: 0,
      enabledBackupDestinations: 0,
      verifiedRestores: 0,
      modelVerification: null,
      securityReviewed: false,
      approvalPolicySet: false,
      unacknowledgedPolicyChanges: 1,
      storageLimitsValid: false,
    });
    const failed = scan.checks.filter((c) => c.status === 'fail').map((c) => c.key);
    expect(failed).toEqual(['backup', 'restore', 'master_key', 'model', 'security', 'storage']);
    expect(scan.checks.filter((c) => c.status === 'fail').every((c) => c.required)).toBe(true);
  });

  it('keeps optional capabilities as recommendations instead of false failures', () => {
    const scan = buildBestPracticeScan({
      ...healthy,
      publicHttps: false,
      mailVerification: 'skipped',
      enabledIntegrations: 0,
    });
    for (const key of ['public_https', 'mail', 'integrations']) {
      expect(scan.checks.find((c) => c.key === key)).toMatchObject({ status: 'warning', required: false });
    }
  });

  it('does not mistake configuration or a failed probe for health', () => {
    const scan = buildBestPracticeScan({
      ...healthy,
      modelVerification: 'failed',
      mailVerification: 'failed',
      enabledIntegrations: 3,
      unhealthyIntegrations: 1,
    });
    expect(scan.checks.find((c) => c.key === 'model')).toMatchObject({ status: 'fail' });
    expect(scan.checks.find((c) => c.key === 'mail')).toMatchObject({ status: 'warning' });
    expect(scan.checks.find((c) => c.key === 'integrations')).toMatchObject({ status: 'warning' });
  });
});
