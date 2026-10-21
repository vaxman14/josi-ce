import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/** Presence-only checks for organization policy that the pinned CLIs read on
 * Windows. Locations come from the pinned vendor binaries themselves:
 *   Claude Code 2.1.258: C:\Program Files\ClaudeCode\managed-settings.json,
 *     managed-settings.d, managed-mcp.json and SOFTWARE\Policies\ClaudeCode.
 *   Codex 0.152.0: %ProgramData%\OpenAI\Codex\requirements.toml and
 *     managed_config.toml (config.toml is checked as on Linux).
 * Values are never read. Any error other than "absent" counts as present. */
function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
}

function registryKeyPresent(hive: 'HKLM' | 'HKCU', subkey: string): boolean {
  const k = createRequire(import.meta.url)('koffi');
  const registry = k.load('advapi32.dll');
  const open = registry.func('int32 __stdcall RegOpenKeyExW(intptr_t, str16, uint32, uint32, _Out_ intptr_t *)');
  const close = registry.func('int32 __stdcall RegCloseKey(intptr_t)');
  const root = hive === 'HKLM' ? -2147483646 : -2147483647; // 0x80000002 / 0x80000001 as signed handles
  const handle: Array<number | bigint> = [0];
  // KEY_READ | KEY_WOW64_64KEY: policy written for 64-bit tools.
  const status = open(root, subkey, 0, 0x20019 | 0x0100, handle);
  if (status === 0) { close(handle[0]); return true; }
  return status !== 2; // ERROR_FILE_NOT_FOUND is the only "absent"
}

export function windowsClaudePolicyPresent(): boolean {
  const programFiles = process.env.ProgramW6432 || process.env.ProgramFiles || 'C:\\Program Files';
  const base = join(programFiles, 'ClaudeCode');
  return ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json'].some(name => present(join(base, name)))
    || registryKeyPresent('HKLM', 'SOFTWARE\\Policies\\ClaudeCode')
    || registryKeyPresent('HKCU', 'SOFTWARE\\Policies\\ClaudeCode');
}

export function windowsCodexPolicyPresent(): boolean {
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const base = join(programData, 'OpenAI', 'Codex');
  return ['requirements.toml', 'managed_config.toml', 'config.toml'].some(name => present(join(base, name)));
}
