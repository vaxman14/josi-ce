// One turn of a conversation with Josi.
//
// Adapted from the engine's `ownerAgent.ts`. The loop shape is the same —
// call the model, run whatever tools it asked for, feed the results back, up to
// a hop limit — because that part is sound and rewriting it would only find new
// bugs. What changed is everything about who is asking and what stops them.
//
//   engine                              CE
//   ------                              --
//   one verified owner per tenant       every member is a principal for their
//                                       own work; nobody is a principal for
//                                       anyone else's
//   PIN word, because caller ID is      step-up re-auth, because the threat is
//   spoofable                           a held session, not a spoofed number
//   provider hardcoded to Anthropic     Phase 4's registry: capabilities, caps,
//                                       Local-only, fallback
//   tools offered if a connector        tools offered if the capability was
//   object was passed in                PROVEN by the probe
//   full text of every exchange into    lengths only; the words stay in
//   the event log                       `messages`, behind the thread's owner
//
// The last two are the ones worth reading twice. A model that was never proven
// to call tools is not offered any, because offering them produces a confident
// description of work that never happened.
import {
  appendEvent, checkStepUp, createTask, getTemplate, listTasksFor, listTemplates,
  missingSlots, setSlots, transition, enqueue,
  type Db,
} from '@josi-ce/core';
import {
  capabilitiesOf, chat, featureAvailable, loadStoredProvider,
  type ChatMessage, type Capabilities, type RegistryOptions, type ToolResult,
} from '@josi-ce/llm';
import { TASK_TOOLS, TOOL_SPECS_BY_NAME } from './tools.js';

/** Recall over the user's own history, injected by the caller. A function
 * rather than a package dependency: the agent does not care whether recall is
 * Postgres full-text, pgvector, or off. Phase 9 supplies it; until then it is
 * absent and the agent says so rather than inventing. */
export type RecallLookup = (query: string) => Promise<string>;

export interface AgentTurnResult {
  reply: string;
  actions: Array<{ tool: string; result: unknown }>;
  /** Set when the turn could not run at all. The caller shows this instead of a
   * reply — it is never dressed up as something Josi said. */
  refusal?: {
    reason: 'no_model' | 'not_probed' | 'cannot_chat' | 'capped' | 'provider_error';
    message: string;
  };
}

export interface TurnArgs {
  db: Db;
  registry: RegistryOptions;
  /** Whose turn this is. Everything the agent creates belongs to them. */
  userId: string;
  threadId: string;
  history: ChatMessage[];
  inbound: string;
  recall?: RecallLookup;
  /** What a step-up unlock is scoped to. Defaults to the thread, so verifying
   * in one conversation does not silently unlock another. */
  sessionKey?: string;
  maxHops?: number;
}

const HOP_LIMIT = 6;

function systemPrompt(args: {
  capabilities: Capabilities;
  templateNames: string[];
  hasRecall: boolean;
  unavailable: string[];
}): string {
  return [
    'You are Josi, an assistant working for one person inside a small shared workspace.',
    'You are talking to that person. Everything you create belongs to them and nobody else in the workspace sees it unless they share it.',
    'Be brief and direct: lead with the answer, no filler, no preamble.',
    'Plain text only — no markdown, no asterisks, no headings.',
    'You do work through tasks. Fill every required slot BEFORE anything is attempted; if a required slot is missing, ask for it. Never start work with a hole in it.',
    'Never invent a name, number, address or time. If you do not know something, ask or say you do not know.',
    args.templateNames.length
      ? `The kinds of work you can start: ${args.templateNames.join(', ')}.`
      : 'No kinds of work are enabled on this installation, so you cannot start a task.',
    // The honest half. Phase 5 ships the task machinery but nothing that
    // executes against a calendar or a mailbox, so a task can be perfectly
    // formed and still have nothing able to carry it out. Saying so is the
    // difference between "waiting" and a silent failure the user finds later.
    args.unavailable.length
      ? `These are not connected yet, so work that needs them will be prepared and then WAIT rather than happen: ${args.unavailable.join(', ')}. Say that plainly — do not imply anything has been sent, booked or delivered.`
      : '',
    args.capabilities.toolCalling
      ? ''
      : 'You cannot call tools on this installation, so you can talk but cannot create or change anything. Say so if asked to do something.',
    args.hasRecall
      ? 'You can search this person\'s own history. Do that before saying you do not know.'
      : '',
    'Some actions need the person to confirm their password first. If a tool tells you that, relay it exactly and do not attempt the action again on your own.',
  ].filter(Boolean).join(' ');
}

export async function runAssistantTurn(args: TurnArgs): Promise<AgentTurnResult> {
  const { db, userId } = args;
  const actions: AgentTurnResult['actions'] = [];
  const sessionKey = args.sessionKey ?? args.threadId;

  // ---- can we run at all? ------------------------------------------------
  // Asked before anything is spent, and answered honestly. A missing or
  // unproven model is not an error to bury in a reply.
  const stored = await loadStoredProvider(db, 'primary');
  if (!stored) {
    return {
      reply: '', actions,
      refusal: { reason: 'no_model', message: 'No model is configured for this installation yet. An administrator sets that up in the admin section.' },
    };
  }
  const capabilities = capabilitiesOf(stored);
  if (!capabilities || !stored.activated_at) {
    return {
      reply: '', actions,
      refusal: { reason: 'not_probed', message: 'The configured model has not been tested yet, so Josi will not use it. An administrator can run the test from the admin section.' },
    };
  }
  if (!featureAvailable('assistant_chat', capabilities)) {
    return {
      reply: '', actions,
      refusal: { reason: 'cannot_chat', message: 'The configured model could not hold a basic conversation when it was tested, so Josi cannot answer with it.' },
    };
  }

  // ---- what may be offered ----------------------------------------------
  // Tools only if the model was PROVEN to call them. Not "probably supports",
  // not inferred from the model name.
  const templates = await listTemplates(db);
  const unavailable = [...new Set(templates.map((t) => t.requiresCapability).filter(Boolean))] as string[];
  const tools = capabilities.toolCalling ? TASK_TOOLS.map((t) => t.def) : undefined;

  let recalled = '';
  if (args.recall) {
    // Best effort: a recall outage must not cost someone their turn.
    try {
      recalled = await args.recall(args.inbound);
    } catch (err) {
      console.error('recall lookup failed', (err as Error).message);
    }
  }

  const system = systemPrompt({
    capabilities,
    templateNames: templates.map((t) => t.key),
    hasRecall: !!args.recall && !!recalled,
    unavailable,
  }) + (recalled ? `\n\nFrom this person's own history:\n${recalled}` : '');

  const messages: ChatMessage[] = [...args.history, { role: 'user', content: args.inbound }];

  for (let hop = 0; hop < (args.maxHops ?? HOP_LIMIT); hop++) {
    let outcome;
    try {
      outcome = await chat(
        args.registry,
        { messages, system, tools, maxTokens: 1024 },
        { userId, purpose: 'assistant_chat' },
      );
    } catch (err) {
      // Caps, Local-only, a dead provider. The message from the registry is
      // written for a person; it is relayed, not reinterpreted.
      return {
        reply: '', actions,
        refusal: {
          reason: (err as { needsReconfiguration?: boolean }).needsReconfiguration ? 'capped' : 'provider_error',
          message: (err as Error).message,
        },
      };
    }

    const res = outcome.response;
    if (!res.toolCalls.length) return { reply: res.text, actions };

    const toolResults: ToolResult[] = [];
    for (const call of res.toolCalls) {
      let result: unknown;
      try {
        // The gate, in front of everything, keyed by tool name.
        const decision = await checkStepUp(db, { userId, sessionKey, action: call.name });
        if (!decision.allowed) {
          result = { ok: false, error: decision.reason, message: decision.message };
        } else {
          result = await execTool(args, call.name, call.input);
        }
      } catch (err) {
        // The tool's own message, not a stack trace, and never a provider body.
        result = { ok: false, error: 'failed', message: (err as Error).message };
      }
      actions.push({ tool: call.name, result });
      toolResults.push({ toolCallId: call.id, name: call.name, content: JSON.stringify(result) });
    }

    messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
    messages.push({ role: 'user', content: '', toolResults });
  }

  await appendEvent(db, {
    actorUserId: userId,
    actor: 'agent',
    kind: 'agent.hop_limit',
    subjectType: 'thread',
    subjectId: args.threadId,
  });
  return { reply: 'I went round in circles on that one and stopped. Try telling me in a different way.', actions };
}

async function execTool(
  args: TurnArgs,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { db, userId } = args;
  const spec = TOOL_SPECS_BY_NAME.get(name);
  if (!spec) return { ok: false, error: 'unknown_tool', message: `no tool named ${name}` };

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
        threadId: args.threadId,
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
