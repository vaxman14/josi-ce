// Builds the Josi browser extension for every browser family, as unpacked
// development folders (with the fixed development identity, so the ID never
// changes between loads) and as store packages (item 37): one zip per store,
// without the development key, ready to upload to the Chrome Web Store, Edge
// Add-ons and Firefox Add-ons. Brave installs from the Chrome Web Store.
// Safari needs its containing macOS app (Xcode's converter); its folder is the
// web extension part of that app.
//
//   node scripts/unified/build-browser-extensions.mjs <new empty folder>
//
// Publishing steps and what each store asks for: docs/BROWSER_EXTENSION_STORES.md.
import { mkdir, cp, writeFile, readFile, readdir, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const output = resolve(process.argv[2] || join(repo, 'build/unified-browser-extensions'));
const identity = JSON.parse(await readFile(join(repo, 'apps/browser-extension/development-identity.json'), 'utf8'));
const VERSION = '1.0.0';
const FAMILIES = ['chrome', 'brave', 'edge', 'firefox', 'safari'];
const CHROMIUM = ['chrome', 'brave', 'edge'];
/** Stores that take a zip of the folder. Brave uses the Chrome Web Store. */
const STORES = ['chrome', 'edge', 'firefox'];
await mkdir(output); // Preserve any existing candidate; caller chooses a new folder.
await mkdir(join(output, 'store'));
// Store-assigned Chromium IDs, once published; the Josi app's native host
// lists the same ones (BrowserHost.StoreExtensionIds) in its allowed origins.
const storeIds = Array.isArray(identity.chromiumStoreIds) ? identity.chromiumStoreIds.filter(id => /^[a-p]{32}$/.test(id)) : [];
const catalog = { schemaVersion: 1, distribution: 'unpacked-development', version: VERSION, chromiumStoreIds: storeIds, extensions: [], store: [] };

function manifestFor(family, { store }) {
  return {
    // The development key pins the extension ID for unpacked loads. Stores
    // assign the ID themselves and refuse a manifest that carries a key.
    ...(CHROMIUM.includes(family) && !store ? { key: identity.chromiumPublicKey } : {}),
    manifest_version: 3, name: 'Josi Browser Control', version: VERSION,
    description: 'Lets the Josi app on your computer use your browser, only with your permissions. Never touches passwords or payment details.',
    icons: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' },
    // Safari has no downloads API: the worker hands downloads to Josi instead.
    permissions: ['nativeMessaging', 'activeTab', 'tabs', 'scripting', 'storage', 'alarms', ...(family === 'safari' ? [] : ['downloads'])],
    // Site access once, at install (as other assistant extensions do), so no
    // site needs a click in the browser. Each site and action is still
    // decided in Josi's PC Control: saved permissions or the owner's approval.
    host_permissions: ['https://*/*', 'http://*/*'],
    action: { default_popup: 'popup.html', default_title: 'Josi',
      default_icon: { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png' } },
    background: CHROMIUM.includes(family) ? { service_worker: 'background.js' }
      : { scripts: ['config.js', 'native-channel.js', 'background.js'], persistent: false },
    content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
    ...(family === 'firefox' ? { browser_specific_settings: { gecko: { id: identity.firefoxId, strict_min_version: '128.0',
      data_collection_permissions: { required: ['websiteContent', 'websiteActivity', 'browsingActivity'] } } } } : {}),
  };
}

async function inventory(folder, prefix = '', files = []) {
  for (const name of (await readdir(folder)).sort()) {
    const path = prefix + name, source = join(folder, name), info = await lstat(source);
    if (info.isDirectory()) await inventory(source, path + '/', files);
    else if (info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024) {
      files.push({ path, size: info.size, sha256: createHash('sha256').update(await readFile(source)).digest('hex') });
    } else throw new Error('Unsupported extension resource');
  }
  return files;
}
const digestOf = files => createHash('sha256').update(files.map(f => `${f.path}\0${f.sha256}\n`).join('')).digest('hex');
const extensionId = family => family === 'firefox' ? identity.firefoxId : family === 'safari' ? identity.safariId : identity.chromiumId;

for (const family of FAMILIES) {
  const destination = join(output, family);
  await cp(join(repo, 'apps/browser-extension/src'), destination, { recursive: true, force: false, errorOnExist: true });
  await writeFile(join(destination, 'config.js'), `'use strict';\nglobalThis.JOSI_BROWSER_CONFIG = Object.freeze(${JSON.stringify({
    family, ...(family === 'safari' ? { extensionId: identity.safariId } : {}),
  })});\n`, { flag: 'wx' });
  await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifestFor(family, { store: false }), null, 2) + '\n', { flag: 'wx' });
  // Signed container resources carry a reproducible manifest. It describes
  // packaged bytes only; it is not an authority or an installed-extension claim.
  const files = await inventory(destination);
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  catalog.extensions.push({ family, extensionId: extensionId(family), version: VERSION, digest: digestOf(files), files });
}

// Store packages: the same files with the store manifest. The backups' zip
// writer streams and records sizes after each file (a data descriptor), which
// the Chrome Web Store refuses; these packages are small, so they are built in
// memory: deflated, sizes in every header, the layout every store accepts.
const { crc32 } = await import(pathToFileURL(join(repo, 'packages/ops/dist/zip.js')).href);
async function writeZip(destination, sources) {
  const locals = [], central = []; let offset = 0;
  const stamp = { time: 0, date: (2026 - 1980) << 9 | 1 << 5 | 1 }; // fixed, so builds are reproducible
  for (const source of sources) {
    const data = source.data ?? await readFile(source.path);
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed, name = Buffer.from(source.name, 'utf8'), crc = crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(0x0800, 6); head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(stamp.time, 10); head.writeUInt16LE(stamp.date, 12); head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18); head.writeUInt32LE(data.length, 22); head.writeUInt16LE(name.length, 26); head.writeUInt16LE(0, 28);
    locals.push(head, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10); entry.writeUInt16LE(stamp.time, 12); entry.writeUInt16LE(stamp.date, 14); entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += head.length + name.length + body.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sources.length, 8); end.writeUInt16LE(sources.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...locals, directory, end]);
  await writeFile(destination, zip, { flag: 'wx' });
  return { byteSize: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
}
for (const family of STORES) {
  const folder = join(output, family);
  const files = (await inventory(folder)).filter(f => f.path !== 'manifest.json');
  const manifest = Buffer.from(JSON.stringify(manifestFor(family, { store: true }), null, 2) + '\n');
  const sources = [{ name: 'manifest.json', data: manifest }];
  for (const f of files) sources.push({ name: f.path, path: join(folder, f.path) });
  const zip = join(output, 'store', `josi-browser-control-${family}-${VERSION}.zip`);
  const written = await writeZip(zip, sources);
  catalog.store.push({ family, store: family === 'chrome' ? 'Chrome Web Store (Chrome and Brave)' : family === 'edge' ? 'Microsoft Edge Add-ons' : 'Firefox Add-ons (AMO)',
    file: `store/josi-browser-control-${family}-${VERSION}.zip`, byteSize: written.byteSize, sha256: written.sha256 });
}
// The development ID per family, and the Chrome Web Store IDs every Chromium
// native host also accepts (the store build has its own ID).
await writeFile(join(output, 'BrowserDistribution.json'), JSON.stringify({ chrome: identity.chromiumId, brave: identity.chromiumId, edge: identity.chromiumId, firefox: identity.firefoxId, safari: identity.safariId, chromiumStoreIds: storeIds }) + '\n', { flag: 'wx' });
await writeFile(join(output, 'BrowserExtensionCatalog.json'), JSON.stringify(catalog, null, 2) + '\n', { flag: 'wx' });
await writeFile(join(output, 'store', 'README.txt'), [
  `Josi Browser Control ${VERSION}: store packages.`, '',
  ...catalog.store.map(s => `${s.file}  ->  ${s.store}  (${s.byteSize} bytes, sha256 ${s.sha256})`), '',
  'Each zip is uploaded as-is to its store. The steps, the listing text and what each store',
  'asks for are in docs/BROWSER_EXTENSION_STORES.md in the repository.',
  'Brave installs the Chrome Web Store listing. Safari needs the macOS containing app (Xcode).', '',
].join('\n'), { flag: 'wx' });
console.log(JSON.stringify({ output, families: FAMILIES, store: catalog.store.map(s => s.file), installed: false, nativeAuthorityConnected: false }));
