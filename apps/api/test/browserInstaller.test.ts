import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = join(import.meta.dirname, '../../..');
const controller = join(root, 'services/installer/controller.py');
const html = join(root, 'services/installer/index.html');

function python(source: string, installRoot: string) {
  return spawnSync('python3', ['-c', source], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      JOSI_INSTALL_ROOT: installRoot,
      JOSI_INSTALLER_HTML: html,
      JOSI_INSTALL_UID: String(process.getuid?.() ?? 0),
      JOSI_INSTALL_GID: String(process.getgid?.() ?? 0),
    },
  });
}

describe('browser installer controller', () => {
  it('accepts only safe LAN, domain, and reverse-proxy addresses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    try {
      const result = python(`
import importlib.util, json
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.occupied_ports=lambda: {}
good=[
 m.validate({'mode':'lan','lanAddress':'192.168.1.20','httpPort':80,'httpsPort':443,'webPort':8081}),
 m.validate({'mode':'domain','domain':'josi.example.com','httpPort':80,'httpsPort':443,'webPort':8081}),
 m.validate({'mode':'proxy','publicUrl':'https://josi.example.com','httpPort':80,'httpsPort':443,'webPort':8081})]
bad=[]
for value in [
 {'mode':'lan','lanAddress':'127.0.0.1'},
 {'mode':'domain','domain':'bad;touch /tmp/nope'},
 {'mode':'proxy','publicUrl':'http://josi.example.com'},
 {'mode':'proxy','publicUrl':'https://user:pass@josi.example.com'},
 {'mode':'proxy','publicUrl':'https://josi.example.com%0aJOSI_TAG=evil'}]:
 try: m.validate(value)
 except (ValueError, TypeError): bad.append(True)
print(json.dumps({'urls':[x['appUrl'] for x in good], 'bad':len(bad)}))
`, dir);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        urls: ['http://192.168.1.20', 'https://josi.example.com', 'https://josi.example.com'],
        bad: 5,
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('atomically persists the chosen URL, preserves secrets, and backs up reruns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'josi-installer-'));
    writeFileSync(join(dir, '.env'), 'UNCHANGED_SECRET=keep-me\nJOSI_APP_URL=http://old\n', { mode: 0o600 });
    try {
      const result = python(`
import importlib.util, json, pathlib
s=importlib.util.spec_from_file_location('c', ${JSON.stringify(controller)})
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
m.write_env({'mode':'lan','appUrl':'http://192.168.50.20:8088','domain':'','httpPort':8088,'httpsPort':8443,'webPort':8081}, 'a'*64)
p=pathlib.Path(${JSON.stringify(dir)})
print(json.dumps({'env':(p/'.env').read_text(), 'backups':len(list(p.glob('.env.pre-browser-*'))), 'mode':oct((p/'.env').stat().st_mode & 0o777)}))
`, dir);
      expect(result.status, result.stderr).toBe(0);
      const value = JSON.parse(result.stdout);
      expect(value.env).toContain('UNCHANGED_SECRET=keep-me');
      expect(value.env).toContain('JOSI_APP_URL=http://192.168.50.20:8088');
      expect(value.env).toContain(`JOSI_SETUP_TOKEN_SHA256=${'a'.repeat(64)}`);
      expect(value.backups).toBe(1);
      expect(value.mode).toBe('0o600');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('never interpolates browser input into a shell command', () => {
    const source = readFileSync(controller, 'utf8');
    expect(source).toContain('subprocess.run(args');
    expect(source).not.toMatch(/shell\s*=\s*True/);
    expect(source).not.toMatch(/os\.system\(/);
  });

  it('claims the installing state before starting the privileged worker', () => {
    const source = readFileSync(controller, 'utf8');
    expect(source).toMatch(/with START_LOCK:[\s\S]*PROGRESS\.update\(\{"state": "installing"[\s\S]*threading\.Thread/);
  });

  it('consumes the one-time pairing code under a lock', () => {
    const source = readFileSync(controller, 'utf8');
    expect(source).toMatch(/with PAIR_LOCK:[\s\S]*TOKEN_FILE\.exists\(\)[\s\S]*TOKEN_FILE\.unlink/);
  });

  it('shows accessible animated installation progress with named steps', () => {
    const page = readFileSync(html, 'utf8');
    const source = readFileSync(controller, 'utf8');
    expect(page).toContain('role="progressbar"');
    expect(page).toContain('aria-valuenow');
    expect(page).toContain('progress-shimmer');
    expect(page).toContain('Step ${p.step||1} of ${p.totalSteps||5}');
    expect(source).toContain('"percent": 100');
    expect(source).toContain('"totalSteps": 5');
  });

  it('keeps Open Josi hidden until installation completes', () => {
    const page = readFileSync(html, 'utf8');
    expect(page).toContain('id="openAction" class="actions hidden"');
    expect(page).toContain('.actions.hidden{display:none}');
    expect(page).toMatch(/if\(p\.state==='complete'\)\{\$\('openAction'\)\.classList\.remove\('hidden'\)/);
  });
});
