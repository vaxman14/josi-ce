// Local Windows application payload. Build in an isolated source snapshot; never
// stamp the checkout or copy its node_modules junctions into a release payload.
import { copyFile, cp, lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build on Windows x64.');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const version = process.argv[2];
if (!/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(version ?? '')) throw new Error('Supply an exact native candidate version.');
const base = join(repo, 'artifacts/windows-native');
const node = join(base, 'tools/node-v24.21.0-win-x64/node.exe');
if (resolve(process.execPath).toLowerCase() !== resolve(node).toLowerCase()) throw new Error('Run with the pinned private Node runtime.');
const npm = join(dirname(node), 'node_modules/npm/bin/npm-cli.js');
const build = join(base, 'staging', `application-${version}-${randomUUID()}`);
const source = join(build, 'source');
const payload = join(build, 'payload');
const app = join(payload, 'app');
const reports = join(build, 'reports');
const scratch = join(build, 'temp');
for (const path of [source, app, reports, scratch]) await mkdir(path, { recursive: true });
await writeFile(join(build, 'npm-user.config'), '');
await writeFile(join(build, 'npm-global.config'), '');
const env = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
  COMSPEC: process.env.COMSPEC, PATH: dirname(node), TEMP: scratch, TMP: scratch,
  npm_config_cache: join(base, 'cache/npm'),
  npm_config_userconfig: join(build, 'npm-user.config'),
  npm_config_globalconfig: join(build, 'npm-global.config'),
  npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };

async function run(command, args, cwd, label, allowed = [0]) {
  const result = await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let bytes = 0;
    for (const pipe of [child.stdout, child.stderr]) pipe.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) child.kill(); else chunks.push(chunk);
    });
    child.on('error', reject);
    child.on('exit', code => done({ code, output: Buffer.concat(chunks) }));
  });
  await writeFile(join(reports, `${label}.log`), result.output);
  if (!allowed.includes(result.code)) throw new Error(`${label} failed; inspect its local build log.`);
  return result.output;
}

// Git is a build input tool only. It is never copied into, or needed by, Josi.
const git = process.env.JOSI_BUILD_GIT ?? 'C:\\Program Files\\Git\\cmd\\git.exe';
const revision = (await run(git, ['rev-parse', 'HEAD'], repo, 'revision')).toString().trim();
const files = (await run(git, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], repo, 'source-files'))
  .toString().split('\0').filter(Boolean).sort();
const sourceInventory = [];
for (const file of files) {
  if (!(await lstat(join(repo, file))).isFile()) throw new Error(`Source is not a regular file: ${file}`);
  const bytes = await readFile(join(repo, file));
  sourceInventory.push({ path: file, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  const destination = join(source, file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
}
await writeFile(join(reports, 'source-inventory.json'), JSON.stringify(sourceInventory, null, 2) + '\n');
console.log('Building an isolated source snapshot with locked dependencies.');
await run(node, [npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], source, 'dependencies');
await run(node, ['scripts/stamp-edition.mjs', '--edition', 'ce', '--build-id', `${revision.slice(0, 12)}.native.${version}`], source, 'stamp');
await run(node, ['node_modules/typescript/bin/tsc', '-b', '--force'], source, 'typescript');
await run(node, ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/web/tsconfig.json'], source, 'web-types');
await run(node, ['../../scripts/sync-offline-help.mjs'], join(source, 'apps/web'), 'offline-help');
await run(node, ['../../node_modules/vite/bin/vite.js', 'build'], join(source, 'apps/web'), 'web');
// npm's SBOM traversal validates all declared edges even with --omit=dev.
// Generate the production graph while those build-only edges still exist.
const sbom = await run(node, [npm, 'sbom', '--omit=dev', '--sbom-format', 'cyclonedx'], source, 'npm-sbom');
if (JSON.parse(sbom.toString()).bomFormat !== 'CycloneDX') throw new Error('Invalid dependency SBOM.');
await run(node, [npm, 'prune', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], source, 'production-dependencies');
await run(node, [npm, 'audit', '--omit=dev', '--json'], source, 'npm-audit', [0, 1]);

const ownPackages = [];
for (const folder of await readdir(join(source, 'packages'))) {
  try {
    const manifest = JSON.parse(await readFile(join(source, 'packages', folder, 'package.json'), 'utf8'));
    if (manifest.name?.startsWith('@josi-ce/')) ownPackages.push({ folder, manifest });
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
// Only npm's known workspace links are excluded. Any other link fails the
// build instead of following it into the developer's machine.
await cp(join(source, 'node_modules'), join(app, 'node_modules'), { recursive: true, filter: async path => {
  const parts = relative(join(source, 'node_modules'), path).split(/[\\/]/);
  if (parts[0] === '.bin' || parts[0] === '@josi-ce') return false;
  if ((await lstat(path)).isSymbolicLink()) throw new Error('Unexpected dependency link in payload.');
  return true;
} });
for (const { folder, manifest } of ownPackages) {
  const target = join(app, 'node_modules', manifest.name);
  await mkdir(target, { recursive: true });
  await copyFile(join(source, 'packages', folder, 'package.json'), join(target, 'package.json'));
  await cp(join(source, 'packages', folder, 'dist'), join(target, 'dist'), {
    recursive: true, filter: path => !path.endsWith('.map') && !path.endsWith('.d.ts'),
  });
}
for (const name of ['api', 'worker', 'web']) {
  await mkdir(join(app, 'apps', name), { recursive: true });
  await copyFile(join(source, 'apps', name, 'package.json'), join(app, 'apps', name, 'package.json'));
  await cp(join(source, 'apps', name, 'dist'), join(app, 'apps', name, 'dist'), {
    recursive: true, filter: path => !path.endsWith('.map') && !path.endsWith('.d.ts'),
  });
}
await mkdir(join(app, 'packages/db'), { recursive: true });
await copyFile(join(source, 'packages/db/migrate.mjs'), join(app, 'packages/db/migrate.mjs'));
await cp(join(source, 'packages/db/migrations'), join(app, 'packages/db/migrations'), { recursive: true });
await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'josi-ce-native-runtime', private: true,
  type: 'module', version, license: 'AGPL-3.0-or-later' }, null, 2) + '\n');
for (const name of ['LICENSE', 'NOTICE', 'TRADEMARK.md']) await copyFile(join(source, name), join(payload, name));
await mkdir(join(app, 'native'), { recursive: true });
await copyFile(join(source, 'packaging/windows/Runtime.mjs'), join(app, 'native/Runtime.mjs'));
await copyFile(join(source, 'packaging/windows/DatabaseBootstrap.mjs'), join(app, 'native/DatabaseBootstrap.mjs'));
await copyFile(join(source, 'packaging/windows/Snapshot.mjs'), join(app, 'native/Snapshot.mjs'));
await copyFile(join(source, 'packaging/windows/PythonRuntime.py'), join(app, 'native/PythonRuntime.py'));
// Runtime files only. Container recipes, Unix helpers, downloads, build locks
// and tests are source/build evidence and must not enter the Windows product.
for (const [service, names] of [
  ['voice-box', ['gateway.py', 'windows_helper.py', 'windows_limits.py', 'runtime_config.py',
    'settings.py', 'tts.py', 'bounded_http.py', 'COPYING', 'catalog.json']],
  ['scanner', ['windows_amsi.py']],
]) {
  await mkdir(join(app, 'services', service), { recursive: true });
  for (const name of names) await copyFile(join(source, 'services', service, name), join(app, 'services', service, name));
}
await mkdir(join(payload, 'licenses'), { recursive: true });
await copyFile(join(reports, 'npm-sbom.log'), join(payload, 'licenses/npm.cdx.json'));
await copyFile(join(source, 'package-lock.json'), join(payload, 'licenses/npm-package-lock.json'));
// libuv loads add-ons with LOAD_WITH_ALTERED_SEARCH_PATH: placing the CRT only
// beside node.exe is insufficient. Each native add-on receives private, pinned
// release DLLs so it cannot fall back to an installed global redistributable.
const nativeFolders = new Set();
async function findNative(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory()) await findNative(join(path, entry.name));
    else if (entry.isFile() && entry.name.endsWith('.node')) nativeFolders.add(path);
  }
}
await findNative(join(app, 'node_modules'));
let runtimeIndex = 0;
for (const folder of nativeFolders) {
  await run(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-File', join(repo, 'scripts/windows/Copy-MsvcRuntime.ps1'), '-Destination', folder],
    repo, `addon-runtime-${++runtimeIndex}`);
}
const inventory = [];
async function inspect(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const item = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Links cannot be shipped in a Windows payload.');
    if (entry.isDirectory()) await inspect(item);
    else if (entry.isFile()) {
      const bytes = await readFile(item);
      inventory.push({ path: relative(payload, item).replaceAll('\\', '/'), size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') });
    } else throw new Error('Unsupported payload file type.');
  }
}
await inspect(payload);
inventory.sort((a, b) => a.path.localeCompare(b.path, 'en'));
await writeFile(join(reports, 'payload-inventory.json'), JSON.stringify(inventory, null, 2) + '\n');
const result = { version, revision, build, payload, sourceInventorySha256:
  createHash('sha256').update(await readFile(join(reports, 'source-inventory.json'))).digest('hex'),
  files: inventory.length, bytes: inventory.reduce((n, f) => n + f.size, 0),
  installed: false, releaseApproved: false, signed: false };
await writeFile(join(base, 'evidence/application-build.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
