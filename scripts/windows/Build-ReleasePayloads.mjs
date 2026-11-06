// Packs the built application and runtime payloads, the bundled subscription
// CLIs and ffmpeg into one archive per component plus the release manifest the
// setup host (packaging/windows/Invoke-NativeSetup.ps1) verifies and installs.
//
//   node scripts/windows/Build-ReleasePayloads.mjs [--cli-root <node_modules with the pinned CLIs>]
//
// Inputs: evidence/application-build.json (Build-Application.mjs),
//         evidence/runtime-build.json (build_runtimes.py),
//         cache/ffmpeg-9.0.2.zip (packaging/windows/ffmpeg.lock.json),
//         the CLI binaries pinned in packaging/windows/subscription-cli.lock.json.
// Output: staging/release-payloads-<id>/josi-windows-<component>-<version>-x64.zip,
//         release-manifest.json, and evidence/release-assets.json.
import { readFile, writeFile, mkdir, copyFile, readdir, lstat, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const run = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const base = join(repo, 'artifacts/windows-native');
const args = process.argv.slice(2);
const cliRoot = resolve(args.includes('--cli-root') ? args[args.indexOf('--cli-root') + 1] : 'C:/Dev/josi-dev/cli/node_modules');
const json = async path => JSON.parse(await readFile(path, 'utf8'));
const sha256 = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const row = async (root, path) => ({ path: relative(root, path).replaceAll('\\', '/'), size: (await lstat(path)).size, sha256: await sha256(path) });
const powershell = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');

async function walk(folder, out = []) {
  for (const entry of (await readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Link refused in payload: ${path}`);
    if (entry.isDirectory()) await walk(path, out); else if (entry.isFile()) out.push(path); else throw new Error(`Unsupported file: ${path}`);
  }
  return out;
}
async function signedBy(path, publisher) {
  const { stdout } = await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `$s = Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}'; $s.Status.ToString() + '|' + $s.SignerCertificate.Subject`]);
  const [status, subject] = stdout.trim().split('|');
  if (status !== 'Valid' || !subject?.includes(publisher)) throw new Error(`${path} is not validly signed by ${publisher} (${stdout.trim()})`);
}

const app = await json(join(base, 'evidence/application-build.json'));
const runtime = await json(join(base, 'evidence/runtime-build.json'));
const version = app.version;
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version)) throw new Error('Bad application version');
const appInventory = await json(join(app.build, 'reports/payload-inventory.json'));
const runtimeInventory = await json(join(runtime.reports, 'file-inventory.json'));
if (appInventory.length !== app.files || runtimeInventory.length !== runtime.files) throw new Error('Payload inventories changed since the builds');

const output = join(base, 'staging', `release-payloads-${randomUUID().replace(/-/g, '')}`);
const extra = join(output, 'extra');          // cli/, ffmpeg/ and the collected notices
await mkdir(extra, { recursive: true });

// Bundled subscription CLIs, verified against the lock before they enter a payload.
const cliLock = await json(join(repo, 'packaging/windows/subscription-cli.lock.json'));
const codexLock = cliLock.find(e => e.id === 'codex-win32-x64'), claudeLock = cliLock.find(e => e.id === 'claude-win32-x64');
const codexVendor = join(cliRoot, '@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc');
const claudeDir = join(cliRoot, '@anthropic-ai/claude-code-win32-x64');
async function verifyPinned(path, lock, publisher) {
  const info = await lstat(path);
  if (info.size !== lock.binarySize || await sha256(path) !== lock.binarySha256) throw new Error(`${path} does not match packaging/windows/subscription-cli.lock.json`);
  await signedBy(path, publisher);
}
await verifyPinned(join(codexVendor, 'bin/codex.exe'), codexLock, 'OpenAI');
await verifyPinned(join(claudeDir, 'claude.exe'), claudeLock, 'Anthropic');
async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const file of await walk(from)) { const target = join(to, relative(from, file)); await mkdir(dirname(target), { recursive: true }); await copyFile(file, target); }
}
await copyTree(join(codexVendor, 'bin'), join(extra, 'cli/codex/bin'));
await copyTree(join(codexVendor, 'codex-path'), join(extra, 'cli/codex/codex-path'));
for (const name of ['LICENSE', 'README.md', 'package.json']) {
  try { await copyFile(join(cliRoot, '@openai/codex-win32-x64', name), join(extra, 'cli/codex', name)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
await mkdir(join(extra, 'cli/claude'), { recursive: true });
for (const entry of await readdir(claudeDir, { withFileTypes: true })) if (entry.isFile()) await copyFile(join(claudeDir, entry.name), join(extra, 'cli/claude', entry.name));

// ffmpeg from the pinned archive: the two tools and the licence, nothing else.
const ffmpegLock = await json(join(repo, 'packaging/windows/ffmpeg.lock.json'));
const ffmpegZip = join(base, 'cache/ffmpeg-9.0.2.zip');
if ((await lstat(ffmpegZip)).size !== ffmpegLock.size || await sha256(ffmpegZip) !== ffmpegLock.sha256) throw new Error('ffmpeg archive does not match packaging/windows/ffmpeg.lock.json');
const ffmpegTemp = join(output, 'ffmpeg-unpacked');
await run(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${ffmpegZip}' -DestinationPath '${ffmpegTemp}'`]);
const [ffmpegTop] = await readdir(ffmpegTemp);
await mkdir(join(extra, 'ffmpeg'), { recursive: true });
for (const file of ffmpegLock.files) await copyFile(join(ffmpegTemp, ffmpegTop, file), join(extra, 'ffmpeg', file.split('/').pop()));
await rm(ffmpegTemp, { recursive: true, force: true });

// Component groups: every file of every payload lands in exactly one archive.
const groups = { josi: [], node: [], python: [], postgresql: [], caddy: [], 'voice-models': [], cli: [], ffmpeg: [] };
for (const r of appInventory) groups.josi.push({ ...r, source: join(app.payload, r.path) });
for (const r of runtimeInventory) {
  const id = r.path.split('/')[0];
  if (!(id in groups)) throw new Error(`Runtime file outside a component: ${r.path}`);
  groups[id].push({ ...r, source: join(runtime.payload, r.path) });
}
for (const file of await walk(extra)) { const r = await row(extra, file); groups[r.path.split('/')[0]].push({ ...r, source: file }); }

// Third-party notices: every licence file of every component, collected under
// the josi archive's licenses/ folder, plus one index the manifest points at.
const noticeName = /^(?:LICENSE|LICENCE|COPYING|NOTICE|THIRD[-_]PARTY[-_]NOTICES)(?:[._-].*)?$/i;
const notices = join(output, 'notices');
const lines = [`Josi CE ${version} for Windows: third-party components and their licences.`, ''];
const meta = {
  josi: ['AGPL-3.0-or-later and retained dependencies', 'https://github.com/vaxman14/josi-ce/blob/main/LICENSE', version],
  node: ['MIT and upstream third-party notices', 'https://github.com/nodejs/node/blob/v24.21.0/LICENSE', '24.21.0'],
  python: ['Python-2.0 and retained dependencies', 'https://docs.python.org/3.12/license.html', '3.12.15'],
  postgresql: ['PostgreSQL and native dependency notices', 'https://www.postgresql.org/about/licence/', '16.15'],
  caddy: ['Apache-2.0 and Go dependency notices', 'https://github.com/caddyserver/caddy/blob/v2.11.7/LICENSE', '2.11.7'],
  'voice-models': ['Per-file retained model licenses', 'https://github.com/vaxman14/josi-ce/blob/main/services/voice-box/models.lock.json', '1.0.0'],
  cli: ['Apache-2.0 (Codex CLI) and Anthropic commercial terms (Claude Code); vendor-signed binaries', 'https://github.com/vaxman14/josi-ce/blob/main/packaging/windows/subscription-cli.lock.json', `${codexLock.version.replace('-win32-x64', '')}-claude-${claudeLock.version}`],
  ffmpeg: ['LGPL-2.1-or-later and GPL components per the archive notices (gyan.dev essentials build)', 'https://github.com/vaxman14/josi-ce/blob/main/packaging/windows/ffmpeg.lock.json', ffmpegLock.version],
};
for (const [id, files] of Object.entries(groups)) {
  lines.push(`${id} ${meta[id][2]}: ${meta[id][0]} (${meta[id][1]})`);
  if (id === 'josi') continue;
  for (const f of files) {
    if (!noticeName.test(f.path.split('/').pop())) continue;
    const target = join(notices, 'licenses', f.path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(f.source, target);
  }
}
await mkdir(join(notices, 'licenses'), { recursive: true });
await writeFile(join(notices, 'licenses/THIRD_PARTY_NOTICES.txt'), lines.join('\n') + '\n');
for (const file of await walk(notices)) groups.josi.push({ ...(await row(notices, file)), source: file });

// One archive per component, with its inventory inside, the way the setup host
// reads it. Entries are deflated (the backup writer in packages/ops stores
// them, which would double the installer), with the CRC and sizes in a data
// descriptor after each entry and in the central directory.
const { crc32 } = await import(pathToFileURL(join(repo, 'packages/ops/dist/zip.js')).href);
const { createDeflateRaw } = await import('node:zlib');
const { open } = await import('node:fs/promises');
async function writeZip(destination, sources) {
  const out = await open(destination, 'wx');
  const hash = createHash('sha256');
  let offset = 0;
  const central = [];
  const write = async chunk => { await out.write(chunk); hash.update(chunk); offset += chunk.length; };
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  try {
    for (const source of sources) {
      const name = Buffer.from(source.name, 'utf8');
      const start = offset;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0808, 6); local.writeUInt16LE(8, 8);
      local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12);
      local.writeUInt16LE(name.length, 26);
      await write(local); await write(name);
      let crc = 0, size = 0, compressed = 0;
      const deflate = createDeflateRaw({ level: 6 });
      const pending = [];
      deflate.on('data', chunk => { pending.push(chunk); });
      const flush = async () => { while (pending.length) { const chunk = pending.shift(); compressed += chunk.length; await write(chunk); } };
      const feed = async piece => { crc = crc32(piece, crc); size += piece.length; if (!deflate.write(piece)) await new Promise(r => deflate.once('drain', r)); await flush(); };
      if (source.data) await feed(source.data);
      else {
        const file = await open(source.path, 'r');
        try {
          const chunk = Buffer.alloc(4 * 1024 * 1024);
          for (;;) { const { bytesRead } = await file.read(chunk, 0, chunk.length, null); if (!bytesRead) break; await feed(Buffer.from(chunk.subarray(0, bytesRead))); }
        } finally { await file.close(); }
      }
      await new Promise((resolveEnd, reject) => { deflate.once('end', resolveEnd); deflate.once('error', reject); deflate.end(); });
      await flush();
      if (size > 0xffffffff || offset > 0xffffffff) throw new Error('An archive passed 4 GB');
      const descriptor = Buffer.alloc(16);
      descriptor.writeUInt32LE(0x08074b50, 0); descriptor.writeUInt32LE(crc, 4); descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(size, 12);
      await write(descriptor);
      const entry = Buffer.alloc(46);
      entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0808, 8); entry.writeUInt16LE(8, 10);
      entry.writeUInt16LE(dosTime, 12); entry.writeUInt16LE(dosDate, 14);
      entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(compressed, 20); entry.writeUInt32LE(size, 24);
      entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(start, 42);
      central.push(entry, name);
    }
    const directoryStart = offset;
    for (const chunk of central) await write(chunk);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(sources.length, 8); end.writeUInt16LE(sources.length, 10);
    end.writeUInt32LE(offset - directoryStart, 12); end.writeUInt32LE(directoryStart, 16);
    await write(end);
    await out.sync();
  } finally { await out.close(); }
  return { byteSize: offset, sha256: hash.digest('hex') };
}
const components = [];
let totalBytes = 0;
for (const [id, files] of Object.entries(groups)) {
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const seen = new Set();
  for (const f of files) { if (seen.has(f.path)) throw new Error(`Duplicate path in ${id}: ${f.path}`); seen.add(f.path); }
  const inventory = files.map(({ path, size, sha256 }) => ({ path, size, sha256 }));
  const asset = `josi-windows-${id}-${version}-x64.zip`;
  const written = await writeZip(join(output, asset), [
    ...files.map(f => ({ name: f.path, path: f.source })),
    { name: `inventories/${id}.json`, data: Buffer.from(JSON.stringify(inventory)) },
  ]);
  totalBytes += written.byteSize;
  components.push({ id, version: meta[id][2], architecture: 'x64', asset, size: written.byteSize, sha256: written.sha256,
    url: `https://github.com/vaxman14/josi-ce/releases/download/v${version}/${asset}`,
    license: meta[id][0], licenseSource: meta[id][1], redistributionEvidence: 'licenses/THIRD_PARTY_NOTICES.txt' });
  console.log(JSON.stringify({ component: id, files: files.length, bytes: written.byteSize }));
}
await rm(extra, { recursive: true, force: true });
await rm(notices, { recursive: true, force: true });

// The manifest's gate fields are what the setup host reads: an installer that
// carries its own verified payloads takes the "local payloads" path.
const manifest = { schemaVersion: 1, product: 'Josi CE Server', version, architecture: 'x64', releaseTag: `v${version}`, components,
  installable: true, localUnsignedAcceptance: true, licenseGatePassed: false, unsignedAcceptancePassed: false, payloadAcceptancePassed: true, published: false,
  acceptanceScope: 'public release; every component archive is embedded in the signed installer and verified by hash before extraction' };
const manifestPath = join(output, 'release-manifest.json');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
const report = { packaged: true, archivesVerified: true, components: components.length, output, manifestSha256: await sha256(manifestPath), candidate: version,
  bytes: totalBytes, installable: true, localUnsignedAcceptance: true, published: false, signed: false, releaseApproved: false };
await writeFile(join(base, 'evidence/release-assets.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
