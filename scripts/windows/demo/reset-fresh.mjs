// The fresh demo root's reset, as the Windows app runs it for `--demo-reset`
// (Automation.RunReset): Reset-FreshDemo.ps1 under PowerShell, with its output
// passed through.
//
//   node scripts/windows/demo/reset-fresh.mjs <demoRoot>
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] || process.env.JOSI_DEMO_ROOT || 'C:\\Dev\\josi-fresh');
const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'Reset-FreshDemo.ps1'), '-Root', root],
  { stdio: 'inherit', windowsHide: true });
process.exit(result.status ?? 1);
