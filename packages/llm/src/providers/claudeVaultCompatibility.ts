import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { SubscriptionCredentialError } from '@josi-ce/core';
import { windowsClaudePolicyPresent } from './windowsManagedPolicy.js';

const unsupported = () => new SubscriptionCredentialError(
  'This server has managed Claude settings that need a supported Vault integration. Use an API provider on this server.');
let managedPreferencesPresent: (() => boolean) | undefined;

/** Do not override installed organizational policy. Inspect only whether a
 * source exists; no policy values or personal credential stores are read. */
export function requireCompatibleClaudeHost(): void {
  if (process.platform === 'win32') {
    try { if (!windowsClaudePolicyPresent()) return; } catch { /* unreadable counts as present */ }
    throw unsupported();
  }
  if (!['darwin', 'linux'].includes(process.platform)) throw unsupported();
  const base = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
  const paths = ['managed-settings.json', 'managed-settings.d', 'managed-mcp.json'].map(name => `${base}/${name}`);
  if (process.platform === 'darwin') paths.push(
    '/Library/Managed Preferences/com.anthropic.claudecode.plist',
    `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudecode.plist`);
  for (const path of paths) {
    try { lstatSync(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw unsupported();
    }
    throw unsupported();
  }
  if (process.platform !== 'darwin') return;
  try {
    if (!managedPreferencesPresent) {
      const k = createRequire(import.meta.url)('koffi');
      const cf = k.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
      const string = cf.func('void *CFStringCreateWithCString(void *, const char *, unsigned int)');
      const copy = cf.func('void *CFPreferencesCopyKeyList(void *, void *, void *)');
      const count = cf.func('long CFArrayGetCount(void *)');
      const release = cf.func('void CFRelease(void *)');
      managedPreferencesPresent = () => {
        const app = string(null, 'com.anthropic.claudecode', 0x08000100);
        if (!app) throw unsupported();
        try {
          // CFPreferences' public scope identifiers. Check all user/host
          // combinations because MDM preferences need not belong to this uid.
          for (const userName of ['kCFPreferencesCurrentUser', 'kCFPreferencesAnyUser']) {
            for (const hostName of ['kCFPreferencesCurrentHost', 'kCFPreferencesAnyHost']) {
              const user = k.decode(cf.symbol(userName), 'void *'), host = k.decode(cf.symbol(hostName), 'void *');
              if (!user || !host) throw unsupported();
              const keys = copy(app, user, host);
              if (keys) {
                try { if (count(keys) > 0) return true; }
                finally { release(keys); }
              }
            }
          }
          return false;
        } finally { release(app); }
      };
    }
    if (managedPreferencesPresent()) throw unsupported();
  } catch { throw unsupported(); }
}
