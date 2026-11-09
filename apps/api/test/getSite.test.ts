import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '../../..');
const read = (file: string) => readFileSync(join(root, file), 'utf8');

describe('get.heyjosi.com Linux install', () => {
  it('never tells people to run the installer as root, which it refuses', () => {
    expect(read('packaging/linux/install-josi-ce-server.sh')).toContain('not a root shell');
    for (const file of ['site/get/index.html', 'site/get/releases.js']) {
      expect(read(file), file).toMatch(/sh install\.sh/);
      expect(read(file), file).not.toMatch(/sudo\s+(ba)?sh\s+install\.sh/);
    }
  });

  it('pins the install redirects to a server release, not releases/latest', () => {
    // releases/latest can be a desktop-v release, which has no install script.
    const rules = read('site/get/_redirects').split('\n').filter((line) => line.startsWith('/install.sh'));
    expect(rules).toHaveLength(2);
    for (const rule of rules) expect(rule).toMatch(/\/releases\/download\/v\d+\.\d+\.\d+[^/]*\//);
  });
});
