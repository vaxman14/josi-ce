import { lstatSync } from 'node:fs';
import { createRequire } from 'node:module';
import { SubscriptionCredentialError } from '@josi-ce/core';
import { windowsCodexPolicyPresent } from './windowsManagedPolicy.js';

const unsupported = () => new SubscriptionCredentialError(
  'This server has managed Codex settings that may override Vault-only sign-in storage. Use an API provider until those settings have a supported integration.');
let managedPreferencesPresent: (() => boolean) | undefined;

/** Pinned 0.152.0 configuration sources can override command-line file
 * storage. Refuse such a host, rather than weakening or ignoring its policy.
 * Reads only presence of configuration sources, never their values or keys. */
export function requireCompatibleCodexHost(): void {
  if (process.platform === 'win32') {
    if (windowsCodexPolicyPresent()) throw unsupported();
    return;
  }
  if (!['darwin', 'linux'].includes(process.platform)) throw unsupported();
  for (const path of ['/etc/codex/requirements.toml', '/etc/codex/managed_config.toml', '/etc/codex/config.toml']) {
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
      const copy = cf.func('void *CFPreferencesCopyAppValue(void *, void *)');
      const release = cf.func('void CFRelease(void *)');
      managedPreferencesPresent = () => {
        const app = string(null, 'com.openai.codex', 0x08000100);
        if (!app) throw unsupported();
        try {
          for (const name of ['config_toml_base64', 'requirements_toml_base64']) {
            const key = string(null, name, 0x08000100);
            if (!key) throw unsupported();
            try {
              const value = copy(key, app);
              if (value) { release(value); return true; }
            } finally { release(key); }
          }
          return false;
        } finally { release(app); }
      };
    }
    if (managedPreferencesPresent()) throw unsupported();
  } catch { throw unsupported(); }
}
