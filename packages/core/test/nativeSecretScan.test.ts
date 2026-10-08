import { describe, expect, it } from 'vitest';
// The runner consumes the established Bash policy, not an independent ban list.
import { policy, scanText } from '../../../scripts/scan-secrets.mjs';

describe('native repository secret scanner', () => {
  it('loads every literal and credential rule from the existing policy', () => {
    const rules = policy();
    expect(rules.literals).toHaveLength(15);
    expect(rules.expressions).toHaveLength(11);
    for (const value of rules.literals) expect(scanText(value, 'fixture.txt', rules).length).toBeGreaterThan(0);
  });
  it('detects credential shapes without returning their contents', () => {
    const credential = ['sk', 'x'.repeat(25)].join('-');
    const findings = scanText('ordinary text\n' + credential, 'fixture.txt');
    expect(findings).toEqual([{ line: 2, kind: 'credential-shaped string' }]);
    expect(JSON.stringify(findings)).not.toContain(credential);
    expect(scanText(['postgresql://', 'user', ':', 'example-value', '@host'].join(''), 'fixture.txt').length).toBeGreaterThan(0);
  });
  it('keeps approved host exceptions exact and limited to approved files', () => {
    const host = ['heyjosi', 'com'].join('.');
    expect(scanText(`https://help.${host}/`, 'fixture.txt')).toEqual([]);
    expect(scanText(`https://get.${host}/`, 'docs/CLI.md')).toEqual([]);
    expect(scanText(`https://get.${host}/`, 'fixture.txt').length).toBeGreaterThan(0);
    for (const value of [`notget.${host}`, `get.${host}.evil.test`, `ce.get.${host}`, `xhelp.${host}`]) {
      expect(scanText(`https://${value}/`, 'docs/CLI.md').length).toBeGreaterThan(0);
    }
  });
});
