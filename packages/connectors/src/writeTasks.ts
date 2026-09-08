// Carrying out a prepared write task against the connected provider.
//
// WHY THIS MOVED OUT OF THE WORKER (round-3 item 26)
//
// It used to live in `apps/worker/src/jobs.ts`, because the worker was the only
// thing that ran it. That single caller is exactly what item 26 is about: a
// person told Josi in chat to create a calendar event, agreed to it, and then
// had to trust that some other process would pick it up later and do it. The
// product said "ready to go" and the event never appeared, and nothing in the
// conversation ever found out.
//
// So there are now two callers with identical obligations:
//
//   * the worker, draining `task.wake` as before — unchanged behaviour for
//     anything already queued;
//   * the request that AUTHORISED the write (the chat turn under an
//     `automatic` policy, or pressing Approve), which runs it in the same
//     breath and reports what the provider actually said.
//
// One implementation means one place where the capability is re-checked at the
// moment of writing rather than at the moment of drafting, and one place where
// a refusal is turned into a sentence a person can act on.
import { getTask, transition, type Db, type MasterKey } from '@josi-ce/core';
import { accessTokenFor, can, connectionFor } from './connections.js';
import { loadClient } from './oauthClients.js';

/** Write-action tasks only ever meant Google and Microsoft — Dropbox, Box and
 * Nextcloud are storage-only providers with no mailbox, calendar or address
 * book to write to. Narrower than this package's own `Provider` on purpose,
 * the same choice `packages/agent/src/dataTools.ts` makes for the same
 * reason. */
export type WriteProvider = 'google' | 'microsoft';

export type WriteFamily = 'mail' | 'calendar' | 'contacts';

export type WritableTask = Awaited<ReturnType<typeof getTask>>;

/** The template keys that reach outside this installation when carried out. */
const FAMILY_BY_TEMPLATE: Record<string, WriteFamily> = {
  send_message: 'mail',
  schedule_appointment: 'calendar',
  update_contact: 'contacts',
};

const WRITE_CAPABILITY: Record<WriteFamily, Record<WriteProvider, string>> = {
  mail: { google: 'google.mail.send', microsoft: 'microsoft.mail.send' },
  calendar: { google: 'google.calendar.write', microsoft: 'microsoft.calendar.write' },
  contacts: { google: 'google.contacts.write', microsoft: 'microsoft.contacts.write' },
};

/** What an operator would call the switch they need to turn on. */
const FAMILY_LABEL: Record<WriteFamily, string> = {
  mail: 'email sending',
  calendar: 'calendar writing',
  contacts: 'contact writing',
};

export function writeFamilyFor(templateKey: string): WriteFamily | null {
  return FAMILY_BY_TEMPLATE[templateKey] ?? null;
}

/** The action class an approval for this kind of task belongs to.
 *
 * Same three keys `ACTION_CLASSES` already defines, so the approval a person
 * sees on the Approvals page is governed by the setting they set on the
 * Settings page under the same words. */
export function writeActionClassFor(templateKey: string): string | null {
  const family = writeFamilyFor(templateKey);
  if (!family) return null;
  return family === 'mail' ? 'email_send' : family === 'calendar' ? 'calendar_write' : 'contacts_write';
}

/** Can this owner's installation carry this task out at all, right now?
 *
 * Re-read at the moment of writing rather than trusted from the moment of
 * drafting: a capability switched off between the two is the case where a
 * cached answer would let Josi act on permission that had been withdrawn. */
export async function taskWriteEnabled(db: Db, task: WritableTask): Promise<boolean> {
  const family = writeFamilyFor(task.template_key);
  if (!family) return false;
  for (const provider of ['google', 'microsoft'] as WriteProvider[]) {
    if ((await can(db, { ownerUserId: task.owner_user_id, capability: WRITE_CAPABILITY[family][provider] })).allowed) {
      return true;
    }
  }
  return false;
}

export interface WriteTaskContext {
  masterKey?: MasterKey | null;
  /** Injected by the tests so no suite contacts a provider. */
  connectorFetch?: typeof fetch;
}

async function writeSession(db: Db, task: WritableTask, family: WriteFamily, ctx: WriteTaskContext) {
  for (const provider of ['google', 'microsoft'] as WriteProvider[]) {
    if (!(await can(db, { ownerUserId: task.owner_user_id, capability: WRITE_CAPABILITY[family][provider] })).allowed) continue;
    const connection = await connectionFor(db, { ownerUserId: task.owner_user_id, provider }); if (!connection) continue;
    const client = await loadClient(db, ctx.masterKey!, provider);
    const accessToken = await accessTokenFor(db, ctx.masterKey!, { connection, client }, { fetchImpl: ctx.connectorFetch });
    return { provider, accessToken };
  }
  throw new Error(`Enable ${family} write access on the Connections page first.`);
}

function textSlot(task: WritableTask, key: string): string { return String(task.slots[key] ?? '').trim(); }

function listSlot(task: WritableTask, key: string): string[] {
  const value = task.slots[key]; return Array.isArray(value) ? value.map(String).map((v) => v.trim()).filter(Boolean).slice(0, 20) : [];
}

function mailAddress(value: string): string {
  const clean = value.replace(/[\r\n]/g, '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error('A valid email address is required.');
  return clean;
}

function mailHeader(value: string): string { return value.replace(/[\r\n]+/g, ' ').trim(); }

function googlePersonPath(value: string): string {
  if (!/^people\/[A-Za-z0-9._-]+$/.test(value)) throw new Error('That Google contact identifier is not valid.');
  return value;
}

/** Anyone this write would involve besides the owner.
 *
 * Item 26 grants a person's own chat instruction the force of an approval for
 * an ORDINARY SELF-ONLY action. The moment somebody else is on the invitation
 * it stops being self-only: `invite_external` is in `ALWAYS_RISKY`, and a
 * meeting request landing in a stranger's inbox is precisely the thing an
 * apology does not undo. So the presence of other people is what turns the
 * automatic path back into an approval, and it is computed from the slots
 * rather than from anything the model said about them. */
export function otherPeopleInvolved(task: WritableTask): string[] {
  const family = writeFamilyFor(task.template_key);
  if (family === 'calendar') return listSlot(task, 'attendees');
  if (family === 'mail') {
    const to = textSlot(task, 'recipient');
    return [...(to ? [to] : []), ...listSlot(task, 'cc')];
  }
  return [];
}

async function providerFetch(ctx: WriteTaskContext, url: string, accessToken: string, init: RequestInit) {
  const response = await (ctx.connectorFetch ?? fetch)(url, { ...init, headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`The connected provider refused the write (${response.status}).`);
}

export async function executeWriteTask(db: Db, task: WritableTask, ctx: WriteTaskContext): Promise<void> {
  if (task.template_key === 'send_message') {
    const session = await writeSession(db, task, 'mail', ctx); const to = mailAddress(textSlot(task, 'recipient')); const cc = listSlot(task, 'cc').map(mailAddress);
    const bodyText = textSlot(task, 'body') || textSlot(task, 'body_brief');
    if (session.provider === 'google') {
      const raw = [`To: ${to}`, ...(cc.length ? [`Cc: ${cc.join(', ')}`] : []), `Subject: ${mailHeader(textSlot(task, 'subject'))}`, 'Content-Type: text/plain; charset=utf-8', '', bodyText].join('\r\n');
      await providerFetch(ctx, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', session.accessToken,
        { method: 'POST', body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') }) });
    } else await providerFetch(ctx, 'https://graph.microsoft.com/v1.0/me/sendMail', session.accessToken,
      { method: 'POST', body: JSON.stringify({ message: { subject: textSlot(task, 'subject'), body: { contentType: 'Text', content: bodyText },
        toRecipients: [{ emailAddress: { address: to } }], ccRecipients: cc.map((address) => ({ emailAddress: { address } })) } }) });
    return;
  }
  if (task.template_key === 'schedule_appointment') {
    const session = await writeSession(db, task, 'calendar', ctx); const eventId = textSlot(task, 'event_id');
    const googleBody = { summary: textSlot(task, 'title'), description: textSlot(task, 'description'), location: textSlot(task, 'location'),
      start: { dateTime: textSlot(task, 'start') }, end: { dateTime: textSlot(task, 'end') }, attendees: listSlot(task, 'attendees').map((email) => ({ email })) };
    const graphBody = { subject: textSlot(task, 'title'), body: { contentType: 'Text', content: textSlot(task, 'description') }, location: { displayName: textSlot(task, 'location') },
      start: { dateTime: textSlot(task, 'start'), timeZone: 'UTC' }, end: { dateTime: textSlot(task, 'end'), timeZone: 'UTC' },
      attendees: listSlot(task, 'attendees').map((address) => ({ emailAddress: { address }, type: 'required' })) };
    const url = session.provider === 'google'
      ? `https://www.googleapis.com/calendar/v3/calendars/primary/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`
      : `https://graph.microsoft.com/v1.0/me/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;
    await providerFetch(ctx, url, session.accessToken, { method: eventId ? 'PATCH' : 'POST', body: JSON.stringify(session.provider === 'google' ? googleBody : graphBody) }); return;
  }
  if (task.template_key === 'update_contact') {
    const session = await writeSession(db, task, 'contacts', ctx); const contactId = textSlot(task, 'contact_id');
    const url = session.provider === 'google'
      ? contactId ? `https://people.googleapis.com/v1/${googlePersonPath(contactId)}:updateContact?updatePersonFields=names,emailAddresses,phoneNumbers,biographies` : 'https://people.googleapis.com/v1/people:createContact'
      : `https://graph.microsoft.com/v1.0/me/contacts${contactId ? `/${encodeURIComponent(contactId)}` : ''}`;
    const body = session.provider === 'google'
      ? { names: [{ displayName: textSlot(task, 'name') }], emailAddresses: textSlot(task, 'email') ? [{ value: textSlot(task, 'email') }] : [], phoneNumbers: textSlot(task, 'phone') ? [{ value: textSlot(task, 'phone') }] : [], biographies: textSlot(task, 'notes') ? [{ value: textSlot(task, 'notes') }] : [] }
      : { displayName: textSlot(task, 'name'), emailAddresses: textSlot(task, 'email') ? [{ address: textSlot(task, 'email'), name: textSlot(task, 'name') }] : [], businessPhones: textSlot(task, 'phone') ? [textSlot(task, 'phone')] : [], personalNotes: textSlot(task, 'notes') };
    await providerFetch(ctx, url, session.accessToken, { method: contactId ? 'PATCH' : 'POST', body: JSON.stringify(body) }); return;
  }
  throw new Error('No executor exists for this task type.');
}

export function safeTaskError(err: unknown): string {
  const message = err instanceof Error ? err.message : 'The action failed.';
  return message.slice(0, 300);
}

export interface WriteTaskOutcome {
  /** Where the task ended up. `confirmed` is the ONLY value that means the
   * provider accepted the write. */
  state: 'confirmed' | 'failed' | 'skipped';
  /** The real reason, in a sentence, when it did not happen. */
  error?: string;
}

/** Carry a `ready` task out now and record honestly where it ended up.
 *
 * ITEM 26(6) — "ready to go" IS NOT A RESTING PLACE.
 *
 * This used to return silently when the write capability was off, leaving the
 * task at `ready` forever. The Tasks page rendered that as "Ready to go",
 * which reads like the last step before success and was in fact the last step
 * there would ever be. A person watching it had no way to learn that nothing
 * was ever going to happen. So a task that cannot be carried out now FAILS,
 * with the switch to turn on named in the reason — and `failed → ready` is a
 * legal transition, so turning the switch on and retrying still works. */
export async function runWriteTaskNow(
  db: Db,
  taskId: string,
  ctx: WriteTaskContext,
): Promise<WriteTaskOutcome> {
  const task = await getTask(db, taskId);
  // Somebody else got there first — a second worker, or a retry of a job that
  // already ran. Not an error, and emphatically not a second write.
  if (task.state !== 'ready') return { state: 'skipped' };

  const family = writeFamilyFor(task.template_key);
  if (family && !(await taskWriteEnabled(db, task))) {
    const reason = `${FAMILY_LABEL[family]} is not switched on for any connected account, so this was not carried out. Turn it on under Connections, then try again.`;
    await transition(db, task.id, 'attempting', { actor: 'system' });
    await transition(db, task.id, 'failed', { actor: 'system', reason });
    return { state: 'failed', error: reason };
  }

  if (!ctx.masterKey) throw new Error('carrying out a write task needs the installation master key');

  await transition(db, task.id, 'attempting', { actor: 'system' });
  try {
    await executeWriteTask(db, task, ctx);
    await transition(db, task.id, 'confirmed', { actor: 'system' });
    return { state: 'confirmed' };
  } catch (err) {
    const reason = safeTaskError(err);
    await transition(db, task.id, 'failed', { actor: 'system', reason });
    return { state: 'failed', error: reason };
  }
}
