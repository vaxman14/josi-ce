// Fixed offline installer entry. The elevated caller holds the lifecycle lock,
// stops application writers, then reapplies service DACLs before restart.
import { readFileSync, realpathSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const operation = process.argv[2], config = process.argv[3], id = process.argv[4];
  if (process.platform !== 'win32' || process.arch !== 'x64' || !['create', 'restore', 'verify'].includes(operation)
    || !/^[a-f0-9]{32}$/.test(id ?? '') || process.argv.length !== (operation === 'create' ? 5 : operation === 'verify' ? 6 : 7)) throw new Error();
  const program = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (realpathSync(process.execPath).toLowerCase() !== join(program, 'node/JosiRuntime.exe').toLowerCase()) throw new Error();
  const data = resolve(dirname(config), '..');
  if (config !== join(data, 'config/runtime.json')) throw new Error();
  const settings = JSON.parse(readFileSync(config, 'utf8'));
  if (!Number.isInteger(settings.databasePort) || settings.databasePort < 1024 || settings.databasePort > 65535) throw new Error();
  const windows = process.env.SystemRoot;
  if (!windows || !/^[A-Za-z]:\\/.test(windows)) throw new Error();
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, { SystemRoot: windows, WINDIR: windows, PATH: join(program, 'postgresql/bin'),
    TEMP: join(data, 'temp/migrate'), TMP: join(data, 'temp/migrate'), JOSI_NATIVE_RUNTIME: '1', JOSI_DATA_DIR: data });
  const { pgBackupWriter, pgRestoreReader, createNativeSnapshot, restoreNativeSnapshot, verifyNativeSnapshot } = await import('@josi-ce/ops');
  const connection = { host: '127.0.0.1', port: settings.databasePort, user: 'josi', database: 'josi',
    passwordFile: join(data, 'secrets/database-password'), toolsDirectory: join(program, 'postgresql/bin') };
  let result;
  if (operation === 'create') {
    result = await createNativeSnapshot(data, id, pgBackupWriter(connection));
    // The lifecycle host verifies/records this hash before allowing migrations.
    // An interrupted result publication cannot count the backup as verified.
    const path = join(data, 'snapshots', id, 'creation-result.json');
    const file = openSync(path, 'wx');
    try { writeFileSync(file, JSON.stringify(result)); fsyncSync(file); } finally { closeSync(file); }
  } else if (operation === 'verify') {
    result = await verifyNativeSnapshot(data, id, process.argv[5]);
  } else {
    const hash = process.argv[5], attempt = process.argv[6];
    if (!/^[a-f0-9]{64}$/.test(hash) || !/^[a-f0-9]{32}$/.test(attempt)) throw new Error();
    result = await restoreNativeSnapshot(data, id, hash, pgRestoreReader(connection), attempt);
  }
  console.log(JSON.stringify(result));
} catch {
  console.error('Josi recovery did not complete. Its verified snapshot and displaced files have been retained.');
  process.exitCode = 1;
}
