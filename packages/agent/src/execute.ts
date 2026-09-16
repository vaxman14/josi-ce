// Executing one assistant tool call, wherever it was asked for.
//
// Extracted from `assistantAgent.ts` unchanged in behaviour, because it now
// has TWO callers with the same obligations: the in-process agent loop, and
// the MCP server that exposes these same tools to a subscription CLI's own
// agent loop. One implementation means one place where ownership is checked
// and one place where "not yours" and "does not exist" stay the same sentence.
//
// The step-up gate is NOT in here, deliberately. Both callers must consult
// `checkStepUp` BEFORE calling this, each with its own session key — the gate
// is about who is holding the session, which only the caller knows. Keeping it
// at the call sites also keeps this function honest about what it is: the
// action, not the permission.
import {
  ReminderError, cancelReminder, createReminder, createTask, enqueue, getTemplate, listRemindersFor,
  listTasksFor, listTemplates, missingSlots, setSlots, transition,
  type Db,
} from '@josi-ce/core';
import { citationLabel, folderSyncHealthFor, searchDocuments, type FolderSyncHealth } from '@josi-ce/storage';
import { DATA_TOOL_FAMILY, executeDataTool, type ConnectorAccess } from './dataTools.js';
import { executeCustomApiTool, isCustomApiTool } from './customApiTools.js';
import { executeWorkflowTool, WORKFLOW_TOOL_NAMES } from './workflowTools.js';
import { executeObsidianTool, DEVELOPER_INTEGRATION_TOOL, executeDeveloperIntegrationTool, executeDeveloperResourceTool } from './developerIntegrationTools.js';

export interface ToolExecutionContext {
  /** Whose work this is. Everything created belongs to them. Never a value
   * from a request body — the HTTP caller takes it from the session, the MCP
   * server from the context file the provider wrote. */
  userId: string;
  /** The conversation the work came from, when there is one to link. */
  threadId: string | null;
  /** How the connected-data tools reach sealed tokens. Absent for callers
   * that cannot open secrets; those tools then refuse honestly rather than
   * crash. The task and reminder tools never touch it. */
  connectors?: ConnectorAccess | null;
}

export async function executeAssistantTool(
  db: Db,
  ctx: ToolExecutionContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { userId } = ctx;

  // Connected-data reads live in their own module; every one of them
  // re-checks the person's capability switches at this moment, not at the
  // moment the tool was offered.
  if (DATA_TOOL_FAMILY.has(name)) {
    return executeDataTool(db, { userId, access: ctx.connectors ?? null }, name, input);
  }

  // Custom APIs live in their own module for the same reason: the allowlist is
  // re-resolved at THIS moment rather than trusted from when the tool was
  // offered, and a write or a delete becomes a pending approval instead of a
  // request. Both callers of this function get that behaviour without having to
  // remember it.
  if (isCustomApiTool(name)) {
    return executeCustomApiTool(
      db,
      { userId, threadId: ctx.threadId, access: ctx.connectors ?? null },
      name,
      input,
    );
  }
  if (WORKFLOW_TOOL_NAMES.has(name)) {
    if (!ctx.connectors) return { ok: false, message: 'Native workflow credentials are unavailable.' };
    return executeWorkflowTool(db, { userId, threadId: ctx.threadId, masterKey: ctx.connectors.masterKey }, name, input);
  }
  if(name==='list_obsidian_vaults'||name==='read_obsidian_note')return executeObsidianTool(db,userId,name,input);
  if(name===DEVELOPER_INTEGRATION_TOOL)return executeDeveloperIntegrationTool(db,userId);
  if(name==='list_native_resources'){
    if(!ctx.connectors)return {ok:false,message:'Native integration credentials are unavailable.'};
    return executeDeveloperResourceTool(db,userId,input,{masterKey:ctx.connectors.masterKey,fetchImpl:ctx.connectors.fetchImpl});
  }

  switch (name) {
    case 'draft_email':
    case 'draft_calendar_event':
    case 'draft_contact_update': {
      const templateKey = name === 'draft_email' ? 'send_message' : name === 'draft_calendar_event' ? 'schedule_appointment' : 'update_contact';
      const task = await createTask(db, { ownerUserId: userId, templateKey, slots: input, threadId: ctx.threadId ?? undefined });
      await transition(db, task.id, 'awaiting_approval', { actor: 'agent', actorUserId: userId });
      return { ok: true, task_id: task.id, state: 'awaiting_approval', message: 'Prepared, but not carried out. Ask the user to approve this exact task before calling approve_task.' };
    }
    case 'list_task_types': {
      const templates = await listTemplates(db);
      return {
        ok: true,
        types: templates.map((t) => ({
          key: t.key,
          name: t.name,
          required_slots: t.contract.slots.required,
          // Stated per type, so the model cannot claim one kind of work is
          // possible because another one was.
          can_be_carried_out: t.requiresCapability === null,
          waiting_on: t.requiresCapability,
        })),
      };
    }

    case 'create_task': {
      const templateKey = String(input.template_key ?? '');
      const template = await getTemplate(db, templateKey);
      const slots = (input.slots as Record<string, unknown>) ?? {};
      const task = await createTask(db, {
        ownerUserId: userId,
        templateKey,
        slots,
        threadId: ctx.threadId ?? undefined,
      });
      const missing = missingSlots(template.contract, task.slots);
      if (!missing.length) {
        // The person asked for it directly; that is the approval.
        await transition(db, task.id, 'ready', { actor: 'user', actorUserId: userId });
        if (template.requiresCapability === null) {
          await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });
        }
      }
      return {
        ok: true,
        task_id: task.id,
        state: missing.length ? 'drafting' : 'ready',
        missing_slots: missing,
        // Never let "ready" be read as "done".
        will_be_carried_out: template.requiresCapability === null,
        waiting_on: template.requiresCapability,
      };
    }

    case 'update_task_slots': {
      const taskId = String(input.task_id ?? '');
      const owned = await ownTask(db, taskId, userId);
      if (!owned) return NOT_YOURS;
      const task = await setSlots(db, taskId, (input.slots as Record<string, unknown>) ?? {}, {
        actor: 'user', actorUserId: userId,
      });
      const template = await getTemplate(db, task.template_key);
      const missing = missingSlots(template.contract, task.slots);
      if (!missing.length && task.state === 'drafting') {
        await transition(db, task.id, 'ready', { actor: 'user', actorUserId: userId });
        if (template.requiresCapability === null) {
          await enqueue(db, { kind: 'task.wake', payload: { taskId: task.id } });
        }
      }
      return { ok: true, task_id: task.id, missing_slots: missing, state: missing.length ? task.state : 'ready' };
    }

    case 'approve_task': {
      const taskId = String(input.task_id ?? '');
      if (!(await ownTask(db, taskId, userId))) return NOT_YOURS;
      const t = await transition(db, taskId, 'ready', { actor: 'user', actorUserId: userId });
      await enqueue(db, { kind: 'task.wake', payload: { taskId: t.id } });
      return { ok: true, task_id: t.id, state: t.state };
    }

    case 'cancel_task': {
      const taskId = String(input.task_id ?? '');
      if (!(await ownTask(db, taskId, userId))) return NOT_YOURS;
      const t = await transition(db, taskId, 'cancelled', { actor: 'user', actorUserId: userId });
      return { ok: true, task_id: t.id, state: t.state };
    }

    case 'list_open_tasks': {
      const tasks = await listTasksFor(db, { ownerUserId: userId, limit: 20 });
      return {
        ok: true,
        tasks: tasks.map((t) => ({
          task_id: t.id, template: t.template_key, state: t.state, slots: t.slots,
          attempts: t.attempt_count,
        })),
      };
    }

    case 'schedule_reminder': {
      const message = String(input.message ?? '').trim();
      const dueAt = reminderDueAt(input);
      if (!dueAt) {
        return {
          ok: false, error: 'bad_time',
          message: 'Say when: pass in_minutes (a positive number) or due_at (an ISO 8601 time in the future).',
        };
      }
      let reminder;
      try {
        reminder = await createReminder(db, {
          ownerUserId: userId, threadId: ctx.threadId, body: message, dueAt,
        });
      } catch (err) {
        // A refusal the model can relay in the person's own terms. Anything
        // else is a real fault and belongs to the caller's error path.
        if (err instanceof ReminderError) return { ok: false, error: 'bad_reminder', message: err.message };
        throw err;
      }
      return {
        ok: true,
        reminder_id: reminder.id,
        due_at: reminder.due_at,
        // Stated so the model does not promise more than delivery: the message
        // comes back, it is not an autonomous action.
        will_be_delivered: 'Josi will send this message back to the user at that time.',
      };
    }

    case 'search_documents': {
      const query = String(input.query ?? '').trim();
      if (!query) return { ok: false, error: 'bad_query', message: 'Say what to search for.' };
      // Owner-scoped by construction: `searchDocuments` requires the owner and
      // every query inside it is keyed on it. There is no argument the model
      // could pass that widens this beyond the person asking.
      const hits = await searchDocuments(db, { ownerUserId: userId, query, limit: 8 });
      const health = await folderSyncHealthFor(db, userId);
      const degradedNote = degradedFoldersNote(health);
      if (!hits.length) {
        const [indexed] = await db.query<{ n: number }>(
          `select count(*)::int as n
           from documents d
           join folder_mappings m on m.id = d.mapping_id
           left join sync_state s on s.mapping_id = m.id
           where d.owner_user_id = $1 and d.state = 'indexed'
             and (m.provider = 'local' or s.mapping_id is null or s.last_sync_at is not null)`,
          [userId],
        );
        return {
          ok: true,
          hits: [],
          // Two different honest sentences: "nothing matched" and "there is
          // nothing to search" send the person to different fixes. A third
          // clause, when it applies: some of what SHOULD have been searched
          // never made it in, so "nothing matched" is not the same claim as
          // "there was nothing to find" (2026-09 storage-sync diagnostic fix).
          message: [
            (indexed?.n ?? 0) > 0
              ? `No indexed document matched that. ${indexed.n} document(s) are indexed and searchable.`
              : 'No documents are indexed yet. Connect a folder on the Connections page and turn on indexing first.',
            degradedNote,
          ].filter(Boolean).join(' '),
          ...(degradedNote ? { degraded_folders: health.filter(isDegraded).map(describeFolderHealth) } : {}),
        };
      }
      return {
        ok: true,
        hits: hits.map((h) => ({
          citation: citationLabel(h),
          snippet: h.snippet,
          document_id: h.documentId,
        })),
        // Present even on a successful search with real hits: those hits are
        // real, but they are drawn only from whatever DID sync, and a person
        // who asked about "my documents" is asking about all of them, not just
        // the fraction one working connection happened to index. Silence here
        // is exactly the shape of the original bug — a confident answer built
        // from a partial, unstated subset of the truth.
        ...(degradedNote ? {
          note: degradedNote,
          degraded_folders: health.filter(isDegraded).map(describeFolderHealth),
        } : {}),
      };
    }

    case 'list_documents': {
      const limit = Math.max(1, Math.min(Number(input.limit) || 50, 100));
      const documents = await db.query<{
        id: string; filename: string; state: string; skip_reason: string | null; folder: string;
      }>(
        `select d.id, d.filename, d.state, d.skip_reason, m.display_path as folder
         from documents d join folder_mappings m on m.id = d.mapping_id
         left join sync_state s on s.mapping_id = m.id
         where d.owner_user_id = $1
           and (m.provider = 'local' or s.mapping_id is null or s.last_sync_at is not null)
         order by d.updated_at desc limit $2`,
        [userId, limit],
      );
      // The 2026-09 storage-sync diagnostic fix: `documents` on its own says
      // nothing about whether the folder behind each row is actually keeping
      // up. A folder that has never completed a sync contributes ZERO rows
      // here — it is invisible by omission, not listed as empty — so a person
      // with three connected folders and one working one would see a short,
      // plausible-looking list and have no way to know two thirds of their
      // storage was never read at all. `folder_sync_health` makes that explicit
      // instead of silent.
      const health = await folderSyncHealthFor(db, userId);
      return {
        ok: true,
        documents,
        folder_sync_health: health.map(describeFolderHealth),
        ...(degradedFoldersNote(health) ? { note: degradedFoldersNote(health) } : {}),
      };
    }

    case 'list_reminders': {
      const reminders = await listRemindersFor(db, { ownerUserId: userId });
      return {
        ok: true,
        reminders: reminders.map((r) => ({
          reminder_id: r.id, message: r.body, due_at: r.due_at, status: r.status,
        })),
      };
    }

    case 'cancel_reminder': {
      const reminderId = String(input.reminder_id ?? '');
      const cancelled = await cancelReminder(db, { ownerUserId: userId, reminderId });
      // Same sentence for "someone else's", "never existed" and "already
      // settled" — the reasoning behind NOT_YOURS, applied to reminders.
      if (!cancelled) return { ok: false, error: 'not_found', message: 'There is no scheduled reminder with that id.' };
      return { ok: true, reminder_id: cancelled.id, status: cancelled.status };
    }

    default:
      return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };
  }
}

/** Same wording whether the task belongs to someone else or does not exist.
 *
 * A model that learns "that one is not yours" can be steered into enumerating
 * a colleague's task ids — the same reason the HTTP layer answers 404 rather
 * than 403. */
const NOT_YOURS = { ok: false, error: 'not_found', message: 'There is no task with that id.' };

// ------------------------------------------------ document sync honesty
//
// The 2026-09 storage-sync diagnostic fix. `search_documents` and
// `list_documents` used to answer purely from `documents` — whatever rows
// happened to have reached 'indexed' — with no way to say when a chunk of a
// person's connected storage had never been read at all. A folder that never
// completes a sync contributes no rows and raises no error; it is invisible
// by omission. The result, lived through on this installation across a real
// conversation: the same question, "check my docs", got a different-shaped
// answer every time depending on which retry had most recently succeeded or
// failed, each one delivered as if it were the complete, settled picture.
//
// A mapping counts as degraded here in exactly the cases the OWNER should
// hear about: it has never once finished a sync, or its most recent attempts
// are failing. A mapping that is healthy right now but failed once last week
// and has since recovered (0 consecutive_failures) does not qualify —
// `consecutive_failures` resets to 0 on the next clean sync, so a nonzero
// value here always means "failing as of this moment", not "has a history".
function isDegraded(folder: FolderSyncHealth): boolean {
  return folder.neverSynced || folder.consecutiveFailures > 0 || folder.status === 'paused';
}

/** One honest sentence per degraded folder, in the same category vocabulary
 * `sync_state.last_error_category` already uses elsewhere — never a provider's
 * own error text (Rule 4 in storageSync.ts), just enough for the person to
 * know what to do: wait, reconnect, or check the Connections page. */
function describeFolderHealth(folder: FolderSyncHealth): {
  folder: string; provider: string; status: string; ok: boolean; detail: string;
} {
  if (!isDegraded(folder)) {
    return { folder: folder.displayPath, provider: folder.provider, status: folder.status, ok: true, detail: 'syncing normally' };
  }
  let detail: string;
  if (folder.neverSynced) {
    detail = folder.lastErrorCategory
      ? `has never completed a sync (last attempt failed: ${folder.lastErrorCategory})`
      : 'has never completed a sync yet';
  } else if (folder.status === 'paused') {
    detail = `paused after repeated sync failures (${folder.lastErrorCategory ?? 'unknown reason'}) — reconnect on the Connections page`;
  } else {
    detail = `sync is currently failing (${folder.lastErrorCategory ?? 'unknown reason'}, ${folder.consecutiveFailures} attempt(s) in a row)`;
  }
  return { folder: folder.displayPath, provider: folder.provider, status: folder.status, ok: false, detail };
}

/** The single-sentence summary attached to a tool result when at least one
 * connected folder is degraded. Empty string — not attached at all — when
 * every folder is healthy, so a working installation is not nagged on every
 * turn about a state that resolved itself. */
function degradedFoldersNote(health: FolderSyncHealth[]): string {
  const bad = health.filter(isDegraded);
  if (!bad.length) return '';
  const total = health.length;
  if (bad.length === total) {
    return total === 1
      ? `Heads up: your connected folder (${bad[0]!.displayPath}) has not synced successfully — nothing from it is searchable yet.`
      : `Heads up: none of your ${total} connected folders have synced successfully — nothing from them is searchable yet.`;
  }
  const names = bad.map((f) => f.displayPath).join(', ');
  return `Heads up: ${bad.length} of ${total} connected folders have not synced successfully (${names}) — what follows only reflects the folder(s) that did.`;
}

/** The model may say "in five minutes" or name an exact time; both become a
 * Date or nothing. Nothing means the tool answers with instructions rather
 * than guessing a time on the user's behalf. */
function reminderDueAt(input: Record<string, unknown>): Date | null {
  const minutes = Number(input.in_minutes);
  if (Number.isFinite(minutes) && minutes > 0) {
    return new Date(Date.now() + Math.round(minutes * 60_000));
  }
  const at = String(input.due_at ?? '').trim();
  if (at) {
    const parsed = new Date(at);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

async function ownTask(db: Db, taskId: string, userId: string): Promise<boolean> {
  if (!/^[0-9a-fA-F-]{36}$/.test(taskId)) return false;
  const rows = await db.query<{ id: string }>(
    `select id from tasks where id = $1 and owner_user_id = $2`,
    [taskId, userId],
  );
  return rows.length > 0;
}
