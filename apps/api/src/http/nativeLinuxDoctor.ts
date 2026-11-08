import { lstat, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { Db, LoadOptions } from '@josi-ce/core';
import type { DoctorHelper } from './doctorRoutes.js';
import { nativeMacDoctor } from './nativeMacDoctor.js';

interface Options {
  db: Db;
  masterKey?: LoadOptions | false;
  env?: NodeJS.ProcessEnv;
  /** How long a check waits for the root updater to answer. */
  checkTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const VERSION = /^\d+\.\d+\.\d+(?:-[a-z0-9.]+)?$/;

/** The native Linux server's Doctor and updater.
 *
 * Checks are the same read-only probes as the Mac's. Updates go through a root
 * updater the web account cannot command: it may only leave a small request
 * file in its own state folder (`update-request`, watched by josi-update.path)
 * and read the answer the updater writes back (`update-status.json`). Which
 * feed is read, which package is installed and whether its checksum matches
 * are all decided by root.
 */
export function nativeLinuxDoctor(options: Options): DoctorHelper {
  const env = options.env ?? process.env;
  const state = join(env.JOSI_DATA_DIR ?? '', 'state');
  const statusFile = join(state, 'update-status.json');
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const checks = nativeMacDoctor({ db: options.db, masterKey: options.masterKey, env, runtime: 'linux' });

  const status = async (): Promise<Record<string, unknown>> => {
    let saved: Record<string, unknown> = {};
    try {
      const info = await lstat(statusFile);
      if (info.isFile() && info.size <= 65_536) {
        const value = JSON.parse(await readFile(statusFile, 'utf8'));
        if (value && typeof value === 'object') saved = value as Record<string, unknown>;
      }
    } catch { /* No check has run yet. */ }
    const running = env.JOSI_VERSION ?? '';
    return {
      state: ['idle', 'running', 'complete', 'failed'].includes(String(saved.state)) ? saved.state : 'idle',
      currentVersion: running,
      targetVersion: typeof saved.targetVersion === 'string' ? saved.targetVersion : null,
      startedAt: saved.startedAt ?? null, finishedAt: saved.finishedAt ?? null,
      message: typeof saved.message === 'string' ? saved.message : '',
      applyMode: 'package',
      available: saved.available ?? null, checkedAt: saved.checkedAt ?? null,
      lastCheckOk: typeof saved.lastCheckOk === 'boolean' ? saved.lastCheckOk : null,
    };
  };

  const ask = async (request: { operation: 'check' } | { operation: 'update'; version: string }) => {
    const temporary = join(state, `.update-request.${randomBytes(8).toString('hex')}`);
    await writeFile(temporary, JSON.stringify(request), { mode: 0o600, flag: 'wx' });
    await rename(temporary, join(state, 'update-request'));
  };

  const modified = async () => { try { return (await stat(statusFile)).mtimeMs; } catch { return 0; } };

  return async (path, body) => {
    if (path === '/update/status' && body === undefined) return { status: 200, data: await status() };
    if (path === '/update/check' && body === undefined) {
      const before = await modified();
      await ask({ operation: 'check' });
      const deadline = Date.now() + (options.checkTimeoutMs ?? 30_000);
      while (Date.now() < deadline && (await modified()) === before) await sleep(500);
      if ((await modified()) === before) return { status: 504, data: { error: 'The updater did not answer.' } };
      return { status: 200, data: await status() };
    }
    if (path === '/update/start') {
      const version = body && typeof body === 'object' ? (body as Record<string, unknown>).version : null;
      if (typeof version !== 'string' || !VERSION.test(version)) return { status: 400, data: { error: 'Invalid version.' } };
      await ask({ operation: 'update', version });
      return { status: 202, data: { ...(await status()), state: 'running', targetVersion: version,
        startedAt: new Date().toISOString(), finishedAt: null, message: 'Downloading and checking the package.' } };
    }
    if (path === '/doctor/check') return checks(path, body);
    return { status: 409, data: { error: 'Run the Josi install command again to repair the installation; your data is kept.' } };
  };
}
