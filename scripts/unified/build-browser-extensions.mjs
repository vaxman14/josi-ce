import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] || join(repo, 'build/unified-browser-extensions'));
const identity = JSON.parse(await readFile(join(repo, 'apps/browser-extension/development-identity.json'), 'utf8'));
await mkdir(output); // Preserve any existing candidate; caller chooses a new folder.
for (const family of ['chrome', 'brave', 'firefox', 'safari']) {
  const destination = join(output, family);
  await cp(join(repo, 'apps/browser-extension/src'), destination, { recursive: true, force: false, errorOnExist: true });
  await writeFile(join(destination, 'config.js'), `'use strict';\nglobalThis.JOSI_BROWSER_CONFIG = Object.freeze(${JSON.stringify({ family })});\n`, { flag: 'wx' });
  const manifest = {
    ...(['chrome', 'brave'].includes(family) ? { key: identity.chromiumPublicKey } : {}),
    manifest_version: 3, name: 'Josi Workspace', version: '0.7.0',
    description: 'Browser control inside your separate Josi automation workspace.',
    permissions: ['nativeMessaging', 'tabs', 'scripting'], host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_popup: 'popup.html', default_title: 'Josi workspace' },
    background: ['chrome', 'brave'].includes(family) ? { service_worker: 'background.js' }
      : { scripts: ['config.js', 'native-channel.js', 'background.js'], persistent: false },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
    ...(family === 'firefox' ? { browser_specific_settings: { gecko: { id: identity.firefoxId, strict_min_version: '128.0',
      data_collection_permissions: { required: ['websiteContent', 'websiteActivity', 'browsingActivity'] } } } } : {}),
  };
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
}
await writeFile(join(output, 'BrowserDistribution.json'), JSON.stringify({ chrome: identity.chromiumId, brave: identity.chromiumId, firefox: identity.firefoxId, safari: identity.safariId }) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, families: ['chrome', 'brave', 'firefox', 'safari'], installed: false, nativeAuthorityConnected: false }));
