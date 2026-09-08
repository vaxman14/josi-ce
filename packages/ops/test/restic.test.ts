import { describe, expect, it } from 'vitest';
import { nextRun, validateRepository } from '../src/restic.js';

describe('Restic backup destinations', () => {
  it('accepts mounted local and NAS repositories', () => {
    expect(validateRepository('local', '/backup-targets/usb/josi')).toBe('/backup-targets/usb/josi');
    expect(validateRepository('nas', '/mnt/backups/nas/josi')).toBe('/mnt/backups/nas/josi');
  });

  it('refuses arbitrary host paths and traversal', () => {
    expect(() => validateRepository('local', '/etc/josi')).toThrow(/mounted beneath/);
    expect(() => validateRepository('nas', '/backup-targets/../etc')).toThrow(/mounted beneath/);
  });

  it('accepts S3, R2 and B2 repository syntax without embedding credentials', () => {
    expect(validateRepository('s3', 's3:https://s3.us-west-2.amazonaws.com/bucket/josi')).toContain('bucket/josi');
    expect(validateRepository('r2', 's3:https://account.r2.cloudflarestorage.com/bucket/josi')).toContain('r2.cloudflarestorage.com');
    expect(validateRepository('b2', 'b2:bucket:josi')).toBe('b2:bucket:josi');
    expect(() => validateRepository('s3', 's3:http://key:secret@example.com/bucket')).toThrow();
  });
});

describe('backup schedule calculations', () => {
  it('moves a passed daily hour to tomorrow', () => {
    expect(nextRun('daily', 3, null, new Date('2026-09-08T04:00:00Z')).toISOString())
      .toBe('2026-09-09T03:00:00.000Z');
  });

  it('selects the requested weekday', () => {
    const result = nextRun('weekly', 3, 0, new Date('2026-09-08T04:00:00Z'));
    expect(result.getUTCDay()).toBe(0);
    expect(result.toISOString()).toBe('2026-09-13T03:00:00.000Z');
  });
});
