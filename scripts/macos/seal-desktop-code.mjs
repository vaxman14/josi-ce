// Build-time only: prepare a fresh candidate for later Developer ID signing.
import { createHash } from 'node:crypto';
import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { createPackage, getRawHeader } from '@electron/asar';
import { flipFuses, getCurrentFuseWire, FuseVersion, FuseV1Options, FuseState } from '@electron/fuses';

const app = path.resolve(process.argv[2] ?? '');
if (process.platform !== 'darwin' || !app.endsWith('/payload/Applications/Josi.app') || await realpath(app) !== app) {
  throw new Error('Use a fresh unified-build candidate, never an installed app.');
}
const resources = path.join(app, 'Contents/Resources'), source = path.join(resources, 'app'), archive = path.join(resources, 'app.asar');
let files = 0, bytes = 0;
async function inspect(folder) {
  for (const name of await readdir(folder)) {
    const entry = path.join(folder, name), stat = await lstat(entry);
    if (stat.isSymbolicLink()) throw new Error('Desktop source must not contain symlinks.');
    if (stat.isDirectory()) await inspect(entry);
    else if (stat.isFile()) {
      files++; bytes += stat.size;
      if (stat.size > 2 * 1024 * 1024 || bytes > 16 * 1024 * 1024 || files > 1000) throw new Error('Unexpected desktop source size.');
    } else throw new Error('Unsupported desktop source entry.');
  }
}
if (!(await lstat(source)).isDirectory() || (await lstat(source)).isSymbolicLink()) throw new Error('Missing staged desktop source.');
try { await lstat(archive); throw new Error('The archive already exists; use a new candidate.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await inspect(source);
await createPackage(source, archive);
const header = getRawHeader(archive);
const hash = createHash('sha256').update(header.headerString, 'utf8').digest('hex');
const fuses = {
  version: FuseVersion.V1,
  resetAdHocDarwinSignature: false,
  strictlyRequireAllFuses: true,
  [FuseV1Options.RunAsNode]: false,
  // CE sessions are memory-only until their Vault projection is assembled.
  [FuseV1Options.EnableCookieEncryption]: false,
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
  [FuseV1Options.EnableNodeCliInspectArguments]: false,
  [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  [FuseV1Options.OnlyLoadAppFromAsar]: true,
  [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
  [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
  [FuseV1Options.WasmTrapHandlers]: true,
};
await flipFuses(app, fuses);
const actual = await getCurrentFuseWire(app);
for (const [index, enabled] of Object.entries(fuses).filter(([key]) => /^\d+$/.test(key))) {
  if (actual[index] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE)) throw new Error('The packaged Electron fuse state did not match.');
}
// Only the fresh candidate's copy is removed after a complete archive build.
await rm(source, { recursive: true });
process.stdout.write(JSON.stringify({ schemaVersion: 1, archive: 'Resources/app.asar',
  algorithm: 'SHA256', hash, files, bytes, fuses: actual, signed: false }) + '\n');
