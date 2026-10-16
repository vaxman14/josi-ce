import { constants } from 'node:fs';
import { access, lstat, readFile, readdir, statfs } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkReadiness, type Db, type LoadOptions } from '@josi-ce/core';
import { nativeWorkspaceProbe, type WorkspaceMountProbe } from '@josi-ce/storage';
import type { DoctorHelper, DoctorState } from './doctorRoutes.js';
import { voiceHelper, type VoiceHelper } from './voiceBoxRoutes.js';

interface Options {
  db: Db;
  masterKey?: LoadOptions | false;
  env?: NodeJS.ProcessEnv;
  appDirectory?: string;
  platform?: NodeJS.Platform;
  architecture?: string;
  now?: () => number;
  voice?: VoiceHelper;
  workspace?: WorkspaceMountProbe;
}

/** Only the installer's loopback listener is probed. No redirects, cookies,
 * caller-supplied URLs, shell commands, service mutations or privileged helper.
 */
async function proxyReady(address: string): Promise<void> {
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== 'localhost' || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid native address');
  await new Promise<void>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: url.port || 80, path: '/ready',
      headers: { Host: 'localhost' }, agent: false }, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString();
        if (Buffer.byteLength(body) > 16_384) res.destroy(new Error('Readiness response too large'));
      });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const value = JSON.parse(body);
          if (res.statusCode !== 200 || value.ready !== true || !Array.isArray(value.blockers)
            || value.blockers.length) throw new Error('Proxy is not ready');
          resolve();
        } catch { reject(new Error('Proxy is not ready')); }
      });
    });
    req.setTimeout(3_000, () => req.destroy(new Error('Readiness timeout')));
    req.on('error', reject); req.end();
  });
}

/** Native Doctor runs with the existing web account's permissions. The signed
 * installer remains the authority for service repairs and native updates.
 */
export function nativeMacDoctor(options: Options): DoctorHelper {
  const env = options.env ?? process.env;
  const app = options.appDirectory ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  const now = options.now ?? Date.now;
  const data = env.JOSI_DATA_DIR ?? '';
  const version = env.JOSI_VERSION ?? '';
  const voice = options.voice ?? voiceHelper();
  return async (path, body) => {
    if (path === '/update/status' && body === undefined) return { status: 200, data: {
      state: 'idle', currentVersion: version, targetVersion: null, startedAt: null, finishedAt: null,
      applyMode: 'installer', message: 'Mac updates use the signed Josi installer. Your data is retained.',
    } };
    if (path !== '/doctor/check' || body !== undefined) return { status: 409, data: {
      error: 'Use the signed Josi installer for Mac service repairs and updates.',
    } };
    const checks: Array<{ check: string; status: DoctorState }> = [];
    const probe = async (check: string, work: () => Promise<DoctorState | void>) => {
      try { checks.push({ check, status: (await work()) ?? 'pass' }); }
      catch { checks.push({ check, status: 'fail' }); }
    };
    // Keep a stable report order. Every failed probe becomes a separate check;
    // filesystem/SQL/HTTP exception text never crosses the browser boundary.
    await probe('architecture', async () => {
      if ((options.platform ?? process.platform) !== 'darwin'
        || (options.architecture ?? process.arch) !== 'arm64') throw new Error();
    });
    await probe('native_runtime', async () => {
      const meta = JSON.parse(await readFile(join(app, 'package.json'), 'utf8'));
      const cfg = JSON.parse(await readFile(join(data, 'config/runtime.json'), 'utf8'));
      if (!/^\d+\.\d+\.\d+-macos\.\d+$/.test(version) || version !== meta.version
        || cfg.version !== version || cfg.schemaVersion !== 1) throw new Error();
      for (const file of ['apps/api/dist/server.js', 'apps/worker/dist/main.js', 'apps/web/dist/index.html']) {
        if (!(await lstat(join(app, file))).isFile()) throw new Error();
        await access(join(app, file), constants.R_OK);
      }
    });
    await probe('writable_data', async () => {
      if (!data.startsWith('/')) throw new Error();
      for (const folder of ['roots', 'chat-attachments', 'backups', 'diagnostics', 'versions', 'codex', 'state']) {
        const path = join(data, folder);
        if (!(await lstat(path)).isDirectory()) throw new Error();
        await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
      }
    });
    await probe('disk', async () => {
      const disk = await statfs(data);
      if (disk.bavail * disk.bsize < 1024 ** 3) throw new Error();
    });
    await probe('direct_health', async () => {
      if (!(await checkReadiness(options.db, { masterKey: options.masterKey })).ready) throw new Error();
    });
    await probe('migrations', async () => {
      const expected = (await readdir(join(app, 'packages/db/migrations'))).filter(f => /^\d+_.+\.sql$/.test(f));
      const applied = new Set((await options.db.query<{ name: string }>('select name from _migrations')).map(r => r.name));
      if (!expected.length || expected.some(name => !applied.has(name))) throw new Error();
    });
    await probe('public_health', () => proxyReady(env.APP_URL ?? ''));
    await probe('native_worker', async () => {
      const heartbeat = await lstat(join(data, 'state/worker-heartbeat'));
      const age = now() - heartbeat.mtimeMs;
      if (!heartbeat.isFile() || age > 90_000 || age < -30_000) throw new Error();
    });
    await probe('native_voice', async () => {
      const reply = await voice('/status');
      const status = JSON.parse(reply.data.toString());
      if (reply.status !== 200 || status.helperAvailable !== true
        || typeof status.enabled !== 'boolean' || (status.enabled && status.healthy !== true)) throw new Error();
    });
    if (env.JOSI_WORKSPACE_ENABLED === '1') {
      await probe('native_workspace', async () => {
        if (!(await (options.workspace ?? nativeWorkspaceProbe).available('/workspace', false))) throw new Error();
      });
      await probe('native_workspace_mapping', async () => {
        const rows = await options.db.query(`select m.id from folder_mappings m
          join storage_roots r on r.id=m.root_id join storage_capabilities c on c.user_id=m.owner_user_id
          join users u on u.id=m.owner_user_id where r.container_path='/workspace' and r.enabled=true
          and m.provider='local' and m.status='active' and c.may_map_local=true
          and u.role='super_admin' and u.status='active' limit 1`);
        if (!rows.length) throw new Error();
      });
    }
    await probe('native_backup_history', async () => {
      const [row] = await options.db.query<{ count: string }>("select count(*)::text as count from backups where state='complete' and kind='full'");
      return Number(row?.count ?? 0) > 0 ? 'pass' : 'warn';
    });
    await probe('worker_backlog', async () => {
      const [row] = await options.db.query<{ count: string }>("select count(*)::text as count from job_queue where status in ('queued','running','failed','dead')");
      return Number(row?.count ?? 0) < 1000 ? 'pass' : 'warn';
    });
    await probe('push_delivery', async () => {
      const [row] = await options.db.query<{ count: string }>("select count(*)::text as count from push_deliveries where status in ('failed','retry')");
      return Number(row?.count ?? 0) === 0 ? 'pass' : 'warn';
    });
    return { status: 200, data: { runtime: 'macos', checkedAt: new Date(now()).toISOString(),
      safeRepairAvailable: false, checks } };
  };
}
