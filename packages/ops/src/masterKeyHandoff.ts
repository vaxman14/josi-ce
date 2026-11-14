// Putting the backup's master key in place.
//
// The services cannot do it themselves: each service account reads only its own
// copy of the key (secrets/<role>/master-key), and none may write the others'.
// So a restore that carries a key leaves it in the shared state folder and a
// small root-owned helper in the container (packaging/linux/docker/josi-keyswap)
// copies it into every role's secrets, restarts the services and removes it.
// The helper announces itself with a marker file; without one (a plain native
// install) the restore says honestly that the key could not be replaced.
import { existsSync, readFileSync } from 'node:fs';
import { chmod, rename, writeFile } from 'node:fs/promises';
import { parseMasterKey, resolveDataPath } from '@josi-ce/core';

export const KEYSWAP_READY_FILE = '/data/state/keyswap.ready';
export const KEYSWAP_PENDING_FILE = '/data/state/master-key.pending';

/** Whether something in this installation will put a queued key in place. */
export function keySwapAvailable(): boolean { return existsSync(resolveDataPath(KEYSWAP_READY_FILE)); }

/** The key this installation holds now, as raw bytes; null when there is none. */
export function currentMasterKeyBytes(): Buffer | null {
  const path = process.env.MASTER_KEY_FILE;
  if (!path) return null;
  try { return parseMasterKey(readFileSync(path, 'utf8')); } catch { return null; }
}

/** Queues `key` (the backup's file content, hex or base64) for the helper. Throws when it is not a key. */
export async function queueMasterKey(raw: Buffer): Promise<void> {
  const text = raw.toString('utf8').trim();
  const key = parseMasterKey(text);
  const target = resolveDataPath(KEYSWAP_PENDING_FILE);
  const staged = `${target}.new`;
  await writeFile(staged, key.toString('hex') + '\n', { mode: 0o600, flag: 'w' });
  await chmod(staged, 0o600);
  await rename(staged, target);
}
