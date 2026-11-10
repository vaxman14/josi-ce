// "Send me that report": Josi sends a file to one of the person's own devices.
//
// The same transfer the apps' "Send to my devices" makes (migration 0121,
// apps/api/src/http/deviceTransferRoutes.ts), asked for in chat. Only to the
// person's OWN devices, only text she writes herself (a report, notes, a
// summary, CSV, code), never a file she merely can read, and never to another
// person: that stays a choice the person makes in the app.
import type { Db } from '@josi-ce/core';
import type { ToolSpec } from './tools.js';

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_TEXT = 1_000_000;
const MAX_WAITING = 20;

export const SEND_FILE_TOOLS: ToolSpec[] = [
  { def: { name: 'send_file_to_my_devices',
    description: 'Send a text file you write (a report, notes, a summary, a list, CSV, code) to one of the person\'s OWN devices, when they ask you to send, save or put something on their phone, PC or server. It lands in that device\'s Downloads (or Josi\'s inbox there). It cannot send other people\'s files or anything you only read; to someone else, tell them to use Send to my devices in the app. Pass device as the device\'s name or part of it; leave it out to see the list of their devices.',
    parameters: { type: 'object', properties: {
      name: { type: 'string', maxLength: 120, description: 'The file name with its extension, for example "report.md" or "contacts.csv".' },
      text: { type: 'string', maxLength: MAX_TEXT, description: 'The whole text of the file.' },
      device: { type: 'string', maxLength: 80, description: 'The target device\'s name (or part of it) from the list. Omit to list their devices first.' },
    }, required: ['name', 'text'], additionalProperties: false } }, actionClass: null },
];
export const SEND_FILE_TOOL_NAMES = new Set(SEND_FILE_TOOLS.map((t) => t.def.name));
export const SEND_FILE_PROMPT = 'When the person asks you to send or save something to a device ("send me that report", "put it on my phone"), write it as a file and call send_file_to_my_devices; if they have several devices and did not say which, ask, naming them. Say plainly where it went, and never claim it arrived: it appears when that device next checks.';

/** Offered when the person has at least one device that can receive. */
export async function sendFileToolAvailability(db: Db, userId: string): Promise<ToolSpec[]> {
  try {
    const rows = await db.query('select 1 from transfer_devices where user_id = $1 limit 1', [userId]);
    return rows.length ? SEND_FILE_TOOLS : [];
  } catch { return []; }
}

/** A plain file name: no folders, no control characters, an extension kept. */
export function plainFileName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop()!.replace(/[<>:"|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 120);
  return name.length > 0 ? name : 'file.txt';
}

export async function executeSendFileTool(db: Db, userId: string, name: string, input: Record<string, unknown>) {
  if (name !== 'send_file_to_my_devices') return { ok: false, code: 'unknown_tool' };
  const devices = await db.query<{ id: string; name: string; platform: string }>(
    'select id, name, platform from transfer_devices where user_id = $1 order by last_seen_at desc', [userId]);
  if (!devices.length) return { ok: false, code: 'no_devices', message: 'The person has no device signed in to receive files yet. They can open Josi on a phone or PC, or use Send to my devices in the app.' };
  const list = devices.map((d) => ({ name: d.name, platform: d.platform }));
  const wanted = typeof input.device === 'string' ? input.device.trim().toLowerCase() : '';
  const exact = devices.filter((d) => d.name.toLowerCase() === wanted);
  const matches = wanted ? (exact.length ? exact : devices.filter((d) => d.name.toLowerCase().includes(wanted))) : [];
  const target = matches.length === 1 ? matches[0] : devices.length === 1 && !wanted ? devices[0] : null;
  if (!target) return { ok: false, code: matches.length > 1 ? 'which_device' : 'choose_device', devices: list,
    message: matches.length > 1 ? 'More than one device matches. Ask the person which one.' : 'Ask the person which device, naming these.' };

  const text = typeof input.text === 'string' ? input.text : '';
  const bytes = Buffer.from(text, 'utf8');
  if (!bytes.length) return { ok: false, code: 'empty', message: 'There is nothing to send: the file text is empty.' };
  if (bytes.length > MAX_BYTES) return { ok: false, code: 'too_large', message: 'That is larger than 25 MB, the most Josi sends between devices.' };
  const file = plainFileName(typeof input.name === 'string' ? input.name : '');
  const [waiting] = await db.query<{ n: string | number }>(`select count(*) as n from device_transfers where sender_user_id = $1 and state in ('offered', 'accepted')`, [userId]);
  if (Number(waiting?.n ?? 0) >= MAX_WAITING) return { ok: false, code: 'too_many_waiting', message: 'Too many files are still waiting to be received. Try again when some have arrived.' };
  const [row] = await db.query<{ id: string }>(
    `insert into device_transfers (sender_user_id, from_device, recipient_user_id, to_device, name, media_type, size, content, state)
     values ($1, null, $1, $2, $3, 'text/plain', $4, $5, 'accepted') returning id`, [userId, target.id, file, bytes.length, bytes]);
  return { ok: true, transferId: row!.id, file, bytes: bytes.length, to: { name: target.name, platform: target.platform },
    message: `Sent "${file}" to ${target.name}. It appears there the next time that device checks, usually within a few seconds; the person can accept nothing more. Do not say it has arrived.` };
}
