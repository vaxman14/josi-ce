// The Linux server's own PC executor (packaging/linux/pc-executor/josi-pc.mjs).
//
// On Windows and the Mac the executor lives inside the signed-in Josi app, so
// the owner signs in there and approves the PC in a native password dialog. A
// headless Linux server has no app: its executor is josi-pc.service, running
// as the Linux user the owner chose at install. It cannot sign in by itself,
// so the handoff goes through a spool folder (JOSI_PC_SPOOL, root:josi-pc
// 2770) that only the web service and the executor can open:
//
//   1. The executor writes <pcId>.hello.json: its PC id and public key.
//   2. The server lists that PC for the owner (chat and the PC Control page).
//   3. The owner approves "let Josi control this computer" in chat, or Pair on
//      the PC Control page, with their password. The server records the key
//      as the PC's executor identity and writes <pcId>.ticket.json holding a
//      session for the owner.
//   4. The executor takes the ticket, deletes it, and from then on signs every
//      executor request with its key exactly like the Windows app does.
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync, renameSync, unlinkSync, writeSync, fchmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';

export interface LocalExecutorHello { pcId:string; publicKey:string; user:string; host:string; createdAt:string }
const HELLO = /^(linux-[a-f0-9]{32})\.hello\.json$/;
const MAX_BYTES = 4096;

/** The spool folder, when this server has a local executor at all. */
export function localExecutorSpool(): string | null {
  const dir = process.env.JOSI_PC_SPOOL?.trim();
  return dir && dir.startsWith('/') && existsSync(dir) ? dir : null;
}

/** Reads one small regular file without following links or blocking on FIFOs. */
function readSmall(path: string): string | null {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size); let read = 0;
    while (read < stat.size) { const n = readSync(fd, buffer, read, stat.size - read, read); if (n <= 0) break; read += n; }
    return buffer.subarray(0, read).toString('utf8');
  } catch { return null; } finally { closeSync(fd); }
}

function validHello(value: unknown, pcId: string): LocalExecutorHello | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const text = (x: unknown, max: number) => typeof x === 'string' && x.length > 0 && x.length <= max && !/[\u0000-\u001f\u007f]/.test(x);
  if (v.pcId !== pcId || !text(v.publicKey, 100) || !/^[A-Za-z0-9+/]+=*$/.test(String(v.publicKey))) return null;
  if (!text(v.user, 32) || !/^[a-z_][a-z0-9_-]*\$?$/.test(String(v.user)) || !text(v.host, 100) || !text(v.createdAt, 40)) return null;
  return { pcId, publicKey: String(v.publicKey), user: String(v.user), host: String(v.host), createdAt: String(v.createdAt) };
}

/** Every executor that has said hello on this server. */
export function readLocalExecutors(): LocalExecutorHello[] {
  const dir = localExecutorSpool(); if (!dir) return [];
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return []; }
  const found: LocalExecutorHello[] = [];
  for (const name of names) {
    const match = HELLO.exec(name); if (!match) continue;
    const raw = readSmall(join(dir, name)); if (!raw) continue;
    try { const hello = validHello(JSON.parse(raw), match[1]); if (hello) found.push(hello); } catch { /* skip */ }
  }
  return found.slice(0, 8);
}

/** Makes this server's executors known to the owner, before pairing and
 * before control is on, the way the Windows app registers itself at sign-in,
 * so chat can list the server and offer to turn control on. */
export async function syncLocalExecutors(db: Db, owner: string): Promise<LocalExecutorHello[]> {
  const hellos = readLocalExecutors(); if (!hellos.length) return [];
  const [user] = await db.query<{ role: string }>('select role from users where id=$1', [owner]);
  if (user?.role !== 'super_admin') return [];
  for (const hello of hellos)
    await db.query('insert into pc_control_settings(owner_user_id,pc_id) values($1,$2) on conflict do nothing', [owner, hello.pcId]);
  return hellos;
}

export function localExecutorHello(pcId: string): LocalExecutorHello | null {
  return readLocalExecutors().find(h => h.pcId === pcId) ?? null;
}

/** Hands the executor its owner session. Mode 0640 so only root, the web
 * service and the executor (group josi-pc) can read it; the executor deletes
 * it as soon as it has read it. */
export function writeLocalTicket(pcId: string, ticket: { ownerId: string; sessionToken: string; publicKey: string }): void {
  const dir = localExecutorSpool();
  if (!dir || !/^linux-[a-f0-9]{32}$/.test(pcId)) throw new Error('This server has no local PC executor.');
  const final = join(dir, pcId + '.ticket.json'), temporary = join(dir, '.' + pcId + '.' + randomUUID() + '.tmp');
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o640);
  try {
    fchmodSync(fd, 0o640);
    writeSync(fd, JSON.stringify({ pcId, ...ticket, createdAt: new Date().toISOString() }));
  } finally { closeSync(fd); }
  try { renameSync(temporary, final); } catch (error) { try { unlinkSync(temporary); } catch { /* gone */ } throw error; }
}
