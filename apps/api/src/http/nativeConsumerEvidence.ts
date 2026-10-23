// Evidence that a subscription consumer (Josi's bundled Codex CLI and the
// guardian that supervises it) is no longer running on this machine.
//
// The credential store will not reconcile a lost login on a client's say-so or
// on lease expiry alone: the run may still hold the private login copy. When
// the run happened in another process (the worker, or an API process that has
// since restarted) nothing in this process can vouch for it. On the Windows
// native runtime the server, the worker and the CLI all live on this one host,
// so the host's process list is the evidence, and the dead run's private
// login copies are removed once nothing can be using them.
import { execFile } from 'node:child_process';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SubscriptionCredentialError } from '@josi-ce/core';

interface ListedProcess { ProcessId: number; ExecutablePath: string | null; CommandLine: string | null }

const CANNOT_CONFIRM = 'The previous subscription consumer cannot be confirmed stopped.';

/** Josi's own Codex directories: the native runtime puts only them on PATH. */
function bundledCodexDirectories(): string[] {
  const found: string[] = [];
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const dir = entry.trim();
    if (dir && existsSync(join(dir, 'codex.exe'))) found.push(dir.toLowerCase());
  }
  return found;
}

function listProcesses(): Promise<ListedProcess[]> {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true, timeout: 30_000 }, (error, stdout) => {
      if (error) return reject(error);
      try {
        const parsed: unknown = JSON.parse(stdout.trim() || '[]');
        resolve(Array.isArray(parsed) ? parsed as ListedProcess[] : [parsed as ListedProcess]);
      } catch (parseError) { reject(parseError); }
    });
  });
}

/** Removes `josi-codex-vault-*` folders under every role's private temp
 * (data/temp/<role>): a dead run's login copy that nothing can use now. */
function removeStaleLoginCopies(): void {
  const root = dirname(process.env.TEMP ?? '');
  const data = process.env.JOSI_DATA_DIR ?? '';
  if (!root || !data || !root.toLowerCase().startsWith(data.toLowerCase())) return;
  try {
    for (const role of readdirSync(root, { withFileTypes: true })) {
      if (!role.isDirectory()) continue;
      for (const entry of readdirSync(join(root, role.name), { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('josi-codex-vault-')) {
          rmSync(join(root, role.name, entry.name), { recursive: true, force: true });
        }
      }
    }
  } catch { /* best effort; the credential store still clears its own auth */ }
}

export async function confirmNativeCodexConsumerStopped(): Promise<void> {
  if (process.platform !== 'win32' || process.env.JOSI_NATIVE_RUNTIME !== '1') throw new SubscriptionCredentialError(CANNOT_CONFIRM);
  const directories = bundledCodexDirectories();
  let processes: ListedProcess[];
  try { processes = await listProcesses(); }
  catch { throw new SubscriptionCredentialError('The running programs could not be listed, so ' + CANNOT_CONFIRM.charAt(0).toLowerCase() + CANNOT_CONFIRM.slice(1)); }
  const consumer = processes.find(item => {
    const executable = (item.ExecutablePath ?? '').toLowerCase();
    const command = (item.CommandLine ?? '').toLowerCase();
    return directories.some(dir => executable.startsWith(dir + '\\'))
      || command.includes('codexvaultguardian') || command.includes('josi-codex-vault-');
  });
  if (consumer) {
    throw new SubscriptionCredentialError(`A previous subscription run is still running on this PC (process ${consumer.ProcessId}). Stop it, then repair again.`);
  }
  removeStaleLoginCopies();
}
