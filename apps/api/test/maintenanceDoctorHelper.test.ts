import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

// Executes the Bash/Compose maintenance CLI. Native maintenance has its own
// acceptance gate; this is not evidence for a Windows repair or upgrade.
describe.skipIf(process.platform === 'win32')('isolated Doctor maintenance helper', () => {
  it('runs only the fixed check and repair command shapes and returns their report', () => {
    const root = mkdtempSync(join(tmpdir(), 'josi-doctor-helper-'));
    const cli = join(root, 'josi');
    writeFileSync(cli, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${root}/calls"
printf '%s\\n' "\${JOSI_DOCTOR_LOCAL_ONLY:-missing}" >> "${root}/mode"
printf '%s\\n' "\${COMPOSE_PROJECT_NAME:-missing}" >> "${root}/project"
printf '%s\\n' '{"schema":"josi.doctor.v2","checkedAt":"2026-10-03T00:00:00Z","healthy":true,"safeRepairAvailable":false,"failed":[],"checks":[]}'
`);
    chmodSync(cli, 0o700);
    const helperPath = resolve('services/installer/maintenance_helper.py');
    const program = `
import importlib.util, json
from pathlib import Path
spec=importlib.util.spec_from_file_location('maintenance_helper', ${JSON.stringify(helperPath)})
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
manager=module.Manager(Path(${JSON.stringify(root)}), 'unused', 1, 1, 1, 'josi-acceptance')
print(json.dumps([manager.doctor(False), manager.doctor(True)]))
`;
    const result = spawnSync('python3', ['-c', program], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toHaveLength(2);
    const text = readFileSync(join(root, 'calls'), 'utf8');
    const lines = text.trim().split('\n');
    expect(lines[0]).toContain('doctor --json --check-only');
    expect(lines[1]).toMatch(/doctor --json$/);
    expect(text).not.toContain('--ai-repair');
    expect(text).not.toContain('--repair-migrations');
    expect(readFileSync(join(root, 'mode'), 'utf8').trim().split('\n')).toEqual(['1', '1']);
    expect(readFileSync(join(root, 'project'), 'utf8').trim().split('\n')).toEqual(['josi-acceptance', 'josi-acceptance']);
  });

  it('accepts only an exact version approval and persists a successful background update', () => {
    const root = mkdtempSync(join(tmpdir(), 'josi-update-helper-'));
    writeFileSync(join(root, '.env'), 'JOSI_TAG=0.1.68\n');
    const cli = join(root, 'josi');
    writeFileSync(cli, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${root}/calls"
printf '%s\\n' "\${JOSI_UPDATE_LOCAL_ONLY:-missing}" >> "${root}/update-mode"
sed -i 's/JOSI_TAG=0.1.68/JOSI_TAG=0.1.69/' "${root}/.env"
`);
    chmodSync(cli, 0o700);
    const helperPath = resolve('services/installer/maintenance_helper.py');
    const program = `
import importlib.util,json,time
from pathlib import Path
spec=importlib.util.spec_from_file_location('maintenance_helper',${JSON.stringify(helperPath)})
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
manager=module.Manager(Path(${JSON.stringify(root)}),'unused',1,1,1,'josi-acceptance')
try: manager.start_update({'operation':'update','version':'0.1.69','confirm':'yes'})
except ValueError: pass
started=manager.start_update({'operation':'update','version':'0.1.69','confirm':'UPDATE 0.1.69'})
for _ in range(100):
 status=manager.update_status()
 if status['state']!='running':break
 time.sleep(.02)
print(json.dumps({'started':started,'status':status}))
`;
    const result = spawnSync('python3', ['-c', program], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.started.state).toBe('running');
    expect(output.status).toMatchObject({ state: 'complete', currentVersion: '0.1.69', targetVersion: '0.1.69' });
    expect(readFileSync(join(root, 'calls'), 'utf8').trim()).toContain('update 0.1.69 --yes');
    expect(readFileSync(join(root, 'update-mode'), 'utf8').trim()).toBe('1');
  });
});
