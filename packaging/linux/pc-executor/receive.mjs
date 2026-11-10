// "Send to my devices", receiving side, for josi-pc.service: this Linux server
// is one of the owner's devices (its id is its own linux-<32hex> PC id). Files
// sent to it arrive in the PC user's Downloads folder. Server contract:
// apps/api/src/http/deviceTransferRoutes.ts. Offers from other people stay for
// the owner to accept in the web app; only transfers already 'accepted' for
// this device are fetched. Nothing is logged but one line per file.
//
//   const rx = createTransferReceiver({ api, token: () => session?.token, deviceId: () => me.pcId, home, log, isActive });
//   rx.start();   // its own timer: registers, then checks the inbox every ~10 s
import { closeSync, constants, linkSync, lstatSync, mkdirSync, openSync, unlinkSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, posix } from 'node:path';

export const TRANSFER_MAX_BYTES = 25 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A plain base name that is safe to save: no folders, no control characters, not hidden. */
export function safeName(raw) {
  let name = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().replace(/[<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '');
  while (Buffer.byteLength(name) > 200) name = name.slice(0, -1);
  return name.length > 0 ? name : 'file';
}
/** "report.pdf" -> "report (2).pdf" */
export function numbered(name, n) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export function createTransferReceiver({ api, token, deviceId, home, log = () => {}, isActive = () => true, name = `${hostname()} (server)`,
  fetch: fetcher = globalThis.fetch, checkMs = 10000, registerMs = 3600000, folder = join(home, 'Downloads') } = {}) {
  let timer = null, registeredAt = 0, busy = false, lastProblem = '';
  const fetched = new Map();  // id -> saved name, kept until the server acknowledges
  const refused = new Set();
  const base = api.replace(/\/+$/, '') + '/api/device-transfers';
  const headers = extra => ({ accept: 'application/json', 'x-josi-client': 'native', authorization: 'Bearer ' + token(), ...extra });
  async function json(method, path, body) {
    const response = await fetcher(base + path, { method, headers: headers(body === undefined ? {} : { 'content-type': 'application/json' }),
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const text = await response.text();
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    try { return text ? JSON.parse(text) : null; } catch { return null; }
  }
  function ensureFolder() {
    mkdirSync(folder, { recursive: true, mode: 0o755 });
    if (!lstatSync(folder).isDirectory()) throw new Error('Downloads is not a folder');
  }
  /** Streams the content into a private temporary file, then links it under a name that never overwrites. */
  async function save(id, wanted) {
    const response = await fetcher(`${base}/${id}/content?deviceId=${encodeURIComponent(deviceId())}`, { headers: headers({}), signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > TRANSFER_MAX_BYTES) { await response.body?.cancel?.(); throw Object.assign(new Error('too large'), { refuse: true }); }
    ensureFolder();
    const temporary = join(folder, `.josi-${process.pid}-${id}.part`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
    let total = 0;
    try {
      for await (const chunk of response.body) {
        total += chunk.length;
        if (total > TRANSFER_MAX_BYTES) throw Object.assign(new Error('too large'), { refuse: true });
        writeSync(fd, chunk);
      }
    } catch (error) { closeSync(fd); try { unlinkSync(temporary); } catch { /* gone */ } throw error; }
    closeSync(fd);
    try {
      for (let n = 1; n < 1000; n++) {
        const final = join(folder, n === 1 ? wanted : numbered(wanted, n));
        try { linkSync(temporary, final); return posix.basename(final); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
      }
      throw new Error('no free name');
    } finally { try { unlinkSync(temporary); } catch { /* gone */ } }
  }
  async function check() {
    if (!isActive()) return;
    const id = deviceId();
    if (Date.now() - registeredAt >= registerMs) {
      await json('PUT', `/devices/${id}`, { name: name.slice(0, 80), platform: 'linux' });
      registeredAt = Date.now();
    }
    const inbox = await json('GET', `/inbox?deviceId=${encodeURIComponent(id)}`);
    for (const t of Array.isArray(inbox?.transfers) ? inbox.transfers : []) {
      if (!t || t.state !== 'accepted' || typeof t.id !== 'string' || !UUID.test(t.id) || refused.has(t.id)) continue;
      if (!isActive()) return;
      try {
        if (!fetched.has(t.id)) {
          if (!Number.isFinite(t.size) || t.size > TRANSFER_MAX_BYTES) { refused.add(t.id); log('device transfer refused: larger than 25 MB'); continue; }
          fetched.set(t.id, await save(t.id, safeName(t.name)));
          log('received a file from my devices into', folder);
        }
        await json('POST', `/${t.id}/received`, { deviceId: id });
        fetched.delete(t.id);
      } catch (error) {
        if (error.refuse) { refused.add(t.id); log('device transfer refused: larger than 25 MB'); }
        else if (error.status === 404 || error.status === 409) fetched.delete(t.id); // gone or already handled
        else throw error;
      }
    }
  }
  async function poll() {
    if (busy) return; busy = true;
    try { await check(); lastProblem = ''; }
    catch (error) { const m = String(error?.message ?? error); if (m !== lastProblem) { lastProblem = m; log('device transfers:', m); } }
    finally { busy = false; }
  }
  return {
    poll,
    start() { if (timer) return; timer = setInterval(poll, checkMs); timer.unref?.(); void poll(); },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
}
