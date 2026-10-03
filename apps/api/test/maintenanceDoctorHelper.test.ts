import { describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

describe('isolated Doctor maintenance helper', () => {
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
});
