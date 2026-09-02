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
  createTask, enqueue, getTemplate, listTasksFor, listTemplates, missingSlots, setSlots, transition,
  type Db,
} from '@josi-ce/core';

export interface ToolExecutionContext {
  /** Whose work this is. Everything created belongs to them. Never a value
   * from a request body — the HTTP caller takes it from the session, the MCP
   * server from the context file the provider wrote. */
  userId: string;
  /** The conversation the work came from, when there is one to link. */
  threadId: string | null;
}

export async function executeAssistantTool(
  db: Db,
  ctx: ToolExecutionContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { userId } = ctx;

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

async function ownTask(db: Db, taskId: string, userId: string): Promise<boolean> {
  if (!/^[0-9a-fA-F-]{36}$/.test(taskId)) return false;
  const rows = await db.query<{ id: string }>(
    `select id from tasks where id = $1 and owner_user_id = $2`,
    [taskId, userId],
  );
  return rows.length > 0;
}
