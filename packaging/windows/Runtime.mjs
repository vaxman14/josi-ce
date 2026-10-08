// Fixed WinSW application entry point. Configuration contains paths/settings and
// credential FILE names derived below; no plaintext secret or command is accepted.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function fail() {
  console.error('Josi could not start with its installed configuration. Use Repair in Josi CE Server Setup.');
  process.exit(1);
}
try {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error();
  const role = process.argv[2], configFile = process.argv[3];
  if (!['web', 'worker', 'migrate'].includes(role) || !configFile || process.argv.length !== 4) throw new Error();
  const program = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  if (realpathSync(process.execPath).toLowerCase() !== join(program, 'node/JosiRuntime.exe').toLowerCase()) throw new Error();
  const data = resolve(dirname(configFile), '..');
  if (configFile !== join(data, 'config/runtime.json') || !/^[A-Za-z]:\\/.test(data)) throw new Error();
  const file = lstatSync(configFile);
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || file.size > 4096) throw new Error();
  const settings = JSON.parse(readFileSync(configFile, 'utf8'));
  const keys = ['schemaVersion', 'version', 'databasePort', 'apiPort', 'publicUrl', 'setupTokenSha256'];
  if (Object.keys(settings).length !== keys.length || Object.keys(settings).some(key => !keys.includes(key))
    || settings.schemaVersion !== 1 || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(settings.version)
    || !/^[a-f0-9]{64}$/.test(settings.setupTokenSha256)) throw new Error();
  const metadata = JSON.parse(readFileSync(join(program, 'app/package.json'), 'utf8'));
  if (metadata.name !== 'josi-ce-native-runtime' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/.test(metadata.version)) throw new Error();
  // Verified upgrade migrations run against the retained baseline config before
  // activation. Long-lived writers still require an exact activated version.
  if (role !== 'migrate' && metadata.version !== settings.version) throw new Error();
  for (const key of ['databasePort', 'apiPort']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1024 || settings[key] > 65535) throw new Error();
  }
  if (settings.databasePort === settings.apiPort) throw new Error();
  const url = new URL(settings.publicUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error();
  const windows = process.env.SystemRoot;
  if (!windows || !win32.isAbsolute(windows)) throw new Error();
  // SCM does not need a shell, a developer PATH, npm, pip, or interactive user
  // profile. Never pass a parent process's provider secrets to the runtime.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    SystemRoot: windows, WINDIR: windows, COMSPEC: join(windows, 'System32/cmd.exe'),
    PATH: [join(program, 'node'), join(windows, 'System32')].join(';'),
    TEMP: join(data, 'temp', role), TMP: join(data, 'temp', role),
    APPDATA: join(data, 'profiles', role, 'AppData/Roaming'),
    LOCALAPPDATA: join(data, 'profiles', role, 'AppData/Local'),
    USERPROFILE: join(data, 'profiles', role), HOME: join(data, 'profiles', role),
    NODE_ENV: 'production', JOSI_NATIVE_RUNTIME: '1', JOSI_VERSION: settings.version,
    JOSI_DATA_DIR: data, JOSI_STORAGE_ROOT_BASE: join(data, 'roots'),
    JOSI_UPLOAD_DIR: join(data, 'chat-attachments'),
    MASTER_KEY_FILE: join(data, 'secrets/master-key'),
    DATABASE_URL: `postgresql://josi@127.0.0.1:${settings.databasePort}/josi`,
    PGHOST: '127.0.0.1', PGPORT: String(settings.databasePort), POSTGRES_DB: 'josi', POSTGRES_USER: 'josi',
    PGPASSWORD_FILE: join(data, 'secrets/database-password'), JOSI_PG_BIN: join(program, 'postgresql/bin'),
    PORT: String(settings.apiPort), APP_URL: url.origin, WEB_DIR: join(program, 'app/apps/web/dist'),
    JOSI_SETUP_TOKEN_SHA256: settings.setupTokenSha256,
    JOSI_WORKER_HEARTBEAT_FILE: join(data, 'state/worker-heartbeat'),
    CODEX_HOME: join(data, 'codex'),
    JOSI_VOICE_HELPER_TOKEN_FILE: join(data, 'secrets/voice-control-token'),
    JOSI_VOICE_HELPER_PORT: '18082',
    JOSI_PYTHON_EXE: join(program, 'python/python.exe'),
    JOSI_SCANNER_ADAPTER: join(program, 'app/services/scanner/windows_amsi.py'),
    JOSI_SCANNER_TEMP: join(data, 'temp/scanner'),
  });
  process.chdir(join(program, 'app'));
  if (role === 'migrate') {
    // The existing migration runner uses the same file credential. Verify its
    // DACL before it is read; migrations execute only during a setup transaction.
    const { readWindowsSecret } = await import('@josi-ce/core');
    readWindowsSecret(process.env.PGPASSWORD_FILE).fill(0);
  }
  await import(pathToFileURL(join(program, 'app', role === 'migrate'
    ? 'packages/db/migrate.mjs' : `apps/${role === 'web' ? 'api' : 'worker'}/dist/${role === 'web' ? 'server' : 'main'}.js`)).href);
} catch {
  fail();
}
