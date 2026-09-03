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
import { citationLabel, searchDocuments } from '@josi-ce/storage';
import { DATA_TOOL_FAMILY, executeDataTool, type ConnectorAccess } from './dataTools.js';

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

  switch (name) {
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
      if (!hits.length) {
        const [indexed] = await db.query<{ n: number }>(
          `select count(*)::int as n from documents where owner_user_id = $1 and state = 'indexed'`,
          [userId],
        );
        return {
          ok: true,
          hits: [],
          // Two different honest sentences: "nothing matched" and "there is
          // nothing to search" send the person to different fixes.
          message: (indexed?.n ?? 0) > 0
            ? `No indexed document matched that. ${indexed.n} document(s) are indexed and searchable.`
            : 'No documents are indexed yet. Connect a folder on the Connections page and turn on indexing first.',
        };
      }
      return {
        ok: true,
        hits: hits.map((h) => ({
          citation: citationLabel(h),
          snippet: h.snippet,
          document_id: h.documentId,
        })),
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
