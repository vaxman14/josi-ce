// What Josi is allowed to do, and what it is allowed to be offered.
//
// A tool is offered only when the thing behind it actually exists. That is the
// engine's rule and it is the one that keeps the assistant honest: a model with
// a `book_appointment` tool and no calendar will promise a booking, because the
// tool's existence is the promise. Absent tool, absent promise.
import type { ToolDefinition } from '@josi-ce/llm';

/** Everything the assistant can do that changes something.
 *
 * `actionClass` feeds the approval level (M33); `sensitive` feeds the step-up
 * gate. They are separate on purpose: "does the owner want to be asked about
 * this kind of work" and "is this session allowed to do something irreversible"
 * are different questions with different answers. */
export interface ToolSpec {
  def: ToolDefinition;
  /** Null for tools that only read. */
  actionClass: string | null;
  /** Requires a capability the installation may not have yet. */
  requiresCapability?: string;
}

export const TASK_TOOLS: ToolSpec[] = [
  {
    def: {
      name: 'create_task',
      description:
        'Start a piece of work for the user. Fill in every required slot you already know; '
        + 'if something required is missing, ask the user for it rather than guessing.',
      parameters: {
        type: 'object',
        properties: {
          template_key: { type: 'string', description: 'Which kind of work. Use list_task_types first if unsure.' },
          slots: { type: 'object', description: 'Known values for the template slots.' },
        },
        required: ['template_key'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'update_task_slots',
      description: 'Fill or correct slots on an existing task — for example when the user answers a question.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' }, slots: { type: 'object' } },
        required: ['task_id', 'slots'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'list_open_tasks',
      description: "List the user's own open tasks with their state and what is still missing.",
      parameters: { type: 'object', properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'list_task_types',
      description: 'List the kinds of work this installation can take on, and what each one needs.',
      parameters: { type: 'object', properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'approve_task',
      description: 'The user approves a task that is waiting on them; it becomes ready to attempt.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'cancel_task',
      description: 'The user cancels a task. This cannot be undone.',
      parameters: {
        type: 'object',
        properties: { task_id: { type: 'string' } },
        required: ['task_id'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'schedule_reminder',
      description:
        'Schedule a reminder for the user. When it comes due, Josi delivers the message back to '
        + 'them in this conversation (and on Telegram if they have linked it). Give either '
        + 'in_minutes (how far from now) or due_at (an exact ISO 8601 time with timezone).',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'What to say when the reminder fires.' },
          in_minutes: { type: 'number', description: 'Deliver this many minutes from now. Use for "in 5 minutes".' },
          due_at: { type: 'string', description: 'Exact delivery time, ISO 8601 with timezone. Use for "at 3pm".' },
        },
        required: ['message'],
      },
    },
    actionClass: 'task_management',
  },
  {
    def: {
      name: 'list_reminders',
      description: "List the user's own upcoming reminders, with each one's id and delivery time.",
      parameters: { type: 'object', properties: {} },
    },
    actionClass: null,
  },
  {
    def: {
      name: 'cancel_reminder',
      description: 'Cancel one of the user\'s scheduled reminders before it fires. Use list_reminders first if unsure of the id.',
      parameters: {
        type: 'object',
        properties: { reminder_id: { type: 'string' } },
        required: ['reminder_id'],
      },
    },
    actionClass: 'task_management',
  },
];

/** Names that map to the step-up gate. The gate keys on the tool name, so
 * adding a destructive tool later means adding it to SENSITIVE_ACTIONS in core
 * — not remembering to write a guard at the call site. */
export const TOOL_SPECS_BY_NAME = new Map(TASK_TOOLS.map((t) => [t.def.name, t]));
