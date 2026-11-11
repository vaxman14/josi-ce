// Josi's built-in debugger: the case file and the safe repairs.
// Plan: docs/JOSI_DEBUGGER_PLAN.md. Step one of a self-healing doctor.
//
// The owner asks "what went wrong there?". Everything needed to answer is
// already in the database: what was said, which tools ran and what they
// returned, the approval requests, the tasks, the goal, the audit trail. This
// file gathers that for ONE conversation into a fixed, redacted bundle, names
// the patterns it recognises, and carries out a short list of repairs that
// only put Josi's own records right.
//
// What is deliberately not here: free-form queries (the model gets this
// bundle, not a database), secrets of any kind, other people's conversations,
// and any way to change the installed program.
import type { Db } from './db.js';
import { appendEvent } from './events.js';
import { enqueue } from './queue.js';
import { prepareActionAgain, type AssistantActionState } from './actionState.js';
import { controlWorkGoal } from './workGoals.js';

/** HIDE BEFORE RELEASE: set this to false. While it is true the debugger is
 * offered to the owner in beta builds; JOSI_DEBUGGER=0 or =1 overrides it. */
export const DEBUGGER_BUILT_IN = true;
export function debuggerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.JOSI_DEBUGGER === '0') return false;
  if (env.JOSI_DEBUGGER === '1') return true;
  return DEBUGGER_BUILT_IN;
}

export type DebugCause = 'stuck_state' | 'setting' | 'outside' | 'own_answer' | 'defect';
export type DebugRepairKind = 'prepare_request_again' | 'goal_continue' | 'run_reconcile';

export interface DebugFinding {
  code: string;
  cause: DebugCause;
  /** One plain sentence, written for the person. */
  summary: string;
  /** Short ids of the rows it rests on, as they appear in the case file. */
  evidence: string[];
  /** A repair from the fixed list that would put it right, if there is one. */
  repair?: { kind: DebugRepairKind; target_id: string | null; what_it_does: string };
}

export interface DebugCase {
  case_id: string;
  window: { from: string; to: string; minutes: number; note: string };
  build: { version: string; platform: string };
  messages: Array<{ id: string; at: string; from: 'person' | 'josi'; text: string }>;
  turns: Array<{ at: string; status: string; error: string | null; for_goal: boolean; tools: Array<{ tool: string; outcome: string }> }>;
  requests: Array<{ id: string; kind: string; status: string; approval: string | null; created: string; expires: string | null;
    expired: boolean; decided: string | null; carried_out: string | null; on_screen: boolean; task: string | null; task_problem: string | null }>;
  goals: Array<{ id: string; state: string; doing: string | null; asking: string | null; steps: Array<{ title: string; state: string }>;
    next_run: string | null; last_change: string }>;
  goal_events: Array<{ at: string; kind: string; summary: string }>;
  audit: Array<{ at: string; kind: string }>;
  jobs: Array<{ kind: string; status: string; attempts: number; problem: string | null }>;
  accounts: Array<{ provider: string; status: string; healthy: boolean | null }>;
  findings: DebugFinding[];
}

const short = (id: string | null | undefined) => (id ? String(id).slice(0, 8) : '');
const iso = (value: unknown) => (value ? new Date(value as string).toISOString() : null);
const SECRETISH = /(password|passwd|secret|token|api[_-]?key|authorization|bearer\s+[a-z0-9._-]{12,}|sk-[a-z0-9]{12,}|ghp_[a-z0-9]{20,})/i;

/** Text as it may appear in a case file: one line, trimmed, and never a line
 * that looks like it carries a credential. */
export function debugText(value: unknown, max = 280): string {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (SECRETISH.test(text)) return '[left out: it may contain a credential]';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function toolOutcome(result: unknown): string {
  if (!result || typeof result !== 'object') return 'no result';
  const r = result as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof r.state === 'string') parts.push(`state ${r.state}`);
  if (typeof r.status === 'string') parts.push(`status ${r.status}`);
  if (r.ok === false) parts.push('refused');
  if (typeof r.code === 'string') parts.push(`code ${r.code}`);
  if (typeof r.error === 'string') parts.push(`error ${debugText(r.error, 60)}`);
  return parts.join(', ') || (r.ok === true ? 'ok' : 'returned');
}

const POINTS_AT_CARD = /\b(approve|deny)\b[^.]{0,40}\b(control|card|button)\b|\bcard\b[^.]{0,20}\b(above|below)\b/i;

/** Gathers the case file for one of the owner's own conversations. */
export async function collectDebugCase(db: Db, args: { ownerUserId: string; threadId: string; minutes?: number }): Promise<DebugCase> {
  const minutes = Math.max(15, Math.min(Math.trunc(args.minutes ?? 180), 1440));
  const [thread] = await db.query<{ id: string }>('select id from threads where id = $1 and owner_user_id = $2', [args.threadId, args.ownerUserId]);
  if (!thread) throw new Error('That conversation is not yours to look into.');
  const [clock] = await db.query<{ now: string; start: string }>(`select now() as now, now() - make_interval(mins => $1::int) as start`, [minutes]);
  const since = clock!.start;

  const messages = (await db.query<{ id: string; direction: string; body: string; created_at: string }>(
    `select id, direction, body, created_at from messages where thread_id = $1 and created_at >= $2 order by created_at desc limit 40`,
    [args.threadId, since])).reverse();
  const turns = await db.query<{ id: string; status: string; error_code: string | null; work_goal_id: string | null; tool_receipts: unknown;
    assistant_message_id: string | null; created_at: string }>(
    `select id, status, error_code, work_goal_id, tool_receipts, assistant_message_id, created_at from assistant_turns
     where owner_user_id = $1 and thread_id = $2 and created_at >= $3 order by created_at limit 60`, [args.ownerUserId, args.threadId, since]);
  const requests = await db.query<AssistantActionState & { approval_status: string | null; decided_at: string | null; task_state: string | null; fail_reason: string | null; is_expired: boolean }>(
    `select s.*, a.status as approval_status, a.decided_at, t.state as task_state, t.fail_reason,
            (s.status = 'expired' or (s.expires_at is not null and s.expires_at <= now())) as is_expired
     from assistant_action_states s left join approvals a on a.id = s.approval_id left join tasks t on t.id = s.task_id
     where s.owner_user_id = $1 and s.thread_id = $2 and s.created_at >= $3::timestamptz - interval '24 hours' order by s.created_at desc limit 12`,
    [args.ownerUserId, args.threadId, since]);
  const goals = await db.query<{ id: string; state: string; activity: string | null; continuation: { kind?: string; text?: string } | null; steps: unknown;
    continuation_ready_at: string | null; updated_at: string; revision: number }>(
    `select id, state, activity, continuation, steps, continuation_ready_at, updated_at, revision from work_goals
     where owner_user_id = $1 and thread_id = $2 and state not in ('completed', 'cancelled') order by created_at desc limit 5`,
    [args.ownerUserId, args.threadId]).catch(() => []);
  const goalEvents = goals.length ? await db.query<{ kind: string; summary: string; created_at: string }>(
    `select kind, summary, created_at from work_goal_events where owner_user_id = $1 and goal_id = any($2::uuid[]) order by created_at desc limit 15`,
    [args.ownerUserId, goals.map((g) => g.id)]).catch(() => []) : [];
  const audit = await db.query<{ kind: string; created_at: string }>(
    `select kind, created_at from events where actor_user_id = $1 and created_at >= $2 order by created_at desc limit 60`, [args.ownerUserId, since]);
  const jobs = await db.query<{ kind: string; status: string; attempts: number; last_error: string | null }>(
    `select kind, status, attempts, last_error from job_queue
     where (status in ('failed', 'dead') and created_at >= $1) or (status = 'queued' and run_at < now() - interval '5 minutes')
     order by created_at desc limit 10`, [since]).catch(() => []);
  const accounts = await db.query<{ provider: string; status: string; last_check_ok: boolean | null }>(
    `select provider, status, last_check_ok from connections where owner_user_id = $1 order by provider`, [args.ownerUserId]).catch(() => []);

  const findings: DebugFinding[] = [];
  const byMessage = new Map(turns.filter((t) => t.assistant_message_id).map((t) => [t.assistant_message_id!, t]));
  const receipts = (turn: { tool_receipts: unknown }) => (Array.isArray(turn.tool_receipts) ? turn.tool_receipts as Array<{ tool?: string; result?: unknown }> : []);
  const newest = requests[0];
  const lastPerson = [...messages].reverse().find((m) => m.direction === 'in');

  // A request that ran out with nobody having answered it, and nothing newer
  // of its kind carried out since.
  if (newest && newest.is_expired && !newest.executed_at && newest.approval_status !== 'approved') {
    findings.push({
      code: 'request_expired_unanswered', cause: 'stuck_state',
      summary: `The ${newest.domain} request made at ${iso(newest.created_at)} expired at ${iso(newest.expires_at)} without being approved, so there is no card or button for it any more.`,
      evidence: [`request ${short(newest.id)}`],
      repair: { kind: 'prepare_request_again', target_id: newest.id,
        what_it_does: 'Prepares the same exact action again with a new approval request, so a working card appears. Nothing is sent or changed until the person approves it.' },
    });
  }
  // Josi pointed the person at a card in a turn where no tool prepared one
  // and no request was live.
  for (const message of messages) {
    if (message.direction !== 'out' || !POINTS_AT_CARD.test(message.body)) continue;
    const turn = byMessage.get(message.id);
    const prepared = turn ? receipts(turn).some((r) => (r.result as { state?: unknown } | null)?.state === 'prepared') : false;
    // Live at the time she said it, whatever became of it since.
    const liveThen = requests.some((r) => r.presented_turn_id === message.id || (new Date(r.created_at) <= new Date(message.created_at)
      && (!r.expires_at || new Date(r.expires_at) > new Date(message.created_at))));
    if (!prepared && !liveThen) {
      findings.push({ code: 'pointed_at_missing_card', cause: 'own_answer',
        summary: `At ${iso(message.created_at)} Josi told the person to use an approval card, but no request was waiting then and no tool had prepared one in that turn.`,
        evidence: [`message ${short(message.id)}`] });
      break;
    }
  }
  for (const goal of goals) {
    const asking = goal.continuation?.kind === 'question' ? String(goal.continuation.text ?? '') : '';
    const doneSince = requests.find((r) => r.status === 'succeeded' && r.executed_at && new Date(r.executed_at) > new Date(goal.updated_at));
    if (['needs_instruction', 'waiting'].includes(goal.state) && doneSince) {
      findings.push({ code: 'goal_waiting_on_finished_work', cause: 'defect',
        summary: `The goal has been "${goal.state.replace('_', ' ')}"${asking ? `, asking "${debugText(asking, 120)}"` : ''} since ${iso(goal.updated_at)}, but the ${doneSince.domain} request it was waiting for was carried out at ${iso(doneSince.executed_at)}. The goal was never told.`,
        evidence: [`goal ${short(goal.id)}`, `request ${short(doneSince.id)}`],
        repair: { kind: 'goal_continue', target_id: goal.id,
          what_it_does: 'Tells the goal that step is done and lets it continue with the next one now. Anything it then wants to send or change still asks the person first.' } });
    } else if (['needs_instruction', 'waiting'].includes(goal.state) && !goal.continuation_ready_at
      && new Date(goal.updated_at) < new Date(Date.parse(clock!.now) - 30 * 60_000)) {
      findings.push({ code: 'goal_idle_nothing_scheduled', cause: asking ? 'stuck_state' : 'defect',
        summary: `The goal has not moved since ${iso(goal.updated_at)} and nothing is scheduled to continue it${asking ? `; it is waiting for the person to answer "${debugText(asking, 120)}"` : ''}.`,
        evidence: [`goal ${short(goal.id)}`] });
    }
  }
  for (const turn of turns) {
    if (turn.status === 'failed' && turn.error_code && turn.error_code !== 'work_control_changed') {
      findings.push({ code: 'turn_failed', cause: 'defect', summary: `A turn at ${iso(turn.created_at)} failed with "${turn.error_code}".`, evidence: [`turn ${short(turn.id)}`] });
      break;
    }
  }
  const failed = requests.find((r) => r.status === 'failed' || r.task_state === 'failed');
  if (failed) findings.push({ code: 'request_failed', cause: 'outside',
    summary: `The ${failed.domain} request was approved but did not go through${failed.fail_reason ? `: ${debugText(failed.fail_reason, 120)}` : ''}.`, evidence: [`request ${short(failed.id)}`] });
  for (const account of accounts) {
    if (account.status !== 'active' || account.last_check_ok === false) {
      findings.push({ code: 'account_unhealthy', cause: 'setting',
        summary: `The connected ${account.provider} account is ${account.status === 'active' ? 'failing its checks' : account.status.replace('_', ' ')}; work that needs it will not go through until it is reconnected.`,
        evidence: [`account ${account.provider}`] });
    }
  }
  if (jobs.length) findings.push({ code: 'background_jobs_stuck', cause: 'stuck_state',
    summary: `${jobs.length} background job${jobs.length === 1 ? ' is' : 's are'} failed or overdue (${[...new Set(jobs.map((j) => j.kind))].slice(0, 4).join(', ')}).`,
    evidence: jobs.slice(0, 4).map((j) => `job ${j.kind}`),
    repair: { kind: 'run_reconcile', target_id: null, what_it_does: 'Runs the housekeeping checks now instead of waiting for their schedule. It changes nothing the person would see by itself.' } });

  const [saved] = await db.query<{ id: string }>(
    `insert into debug_cases (owner_user_id, thread_id, window_minutes, findings) values ($1, $2, $3, $4) returning id`,
    [args.ownerUserId, args.threadId, minutes, JSON.stringify(findings)]);
  await appendEvent(db, { actorUserId: args.ownerUserId, actor: 'agent', kind: 'debug.investigated', subjectType: 'thread', subjectId: args.threadId,
    payload: { caseId: saved!.id, minutes, findings: findings.map((f) => f.code) } });

  return {
    case_id: saved!.id,
    window: { from: iso(since)!, to: iso(clock!.now)!, minutes, note: 'All times are UTC. Convert them to the person\'s own timezone before saying them.' },
    build: { version: process.env.JOSI_VERSION ?? 'unknown', platform: process.platform },
    messages: messages.map((m) => ({ id: short(m.id), at: iso(m.created_at)!, from: m.direction === 'in' ? 'person' as const : 'josi' as const, text: debugText(m.body) })),
    turns: turns.map((t) => ({ at: iso(t.created_at)!, status: t.status, error: t.error_code, for_goal: !!t.work_goal_id,
      tools: receipts(t).slice(0, 12).map((r) => ({ tool: String(r.tool ?? 'tool'), outcome: toolOutcome(r.result) })) })),
    requests: requests.map((r) => ({ id: short(r.id), kind: `${r.domain} ${r.operation}`, status: r.status, approval: r.approval_status, created: iso(r.created_at)!,
      expires: iso(r.expires_at), expired: r.is_expired, decided: iso(r.decided_at), carried_out: iso(r.executed_at), on_screen: !!r.presented_turn_id,
      task: r.task_state, task_problem: r.fail_reason ? debugText(r.fail_reason, 160) : null })),
    goals: goals.map((g) => ({ id: short(g.id), state: g.state, doing: g.activity ? debugText(g.activity, 160) : null,
      asking: g.continuation?.kind === 'question' ? debugText(g.continuation.text, 200) : null,
      steps: (Array.isArray(g.steps) ? g.steps as Array<Record<string, unknown>> : []).slice(0, 12).map((s) => ({ title: debugText(s.title ?? s.text ?? s.summary ?? '', 140), state: String(s.state ?? s.status ?? '') })),
      next_run: iso(g.continuation_ready_at), last_change: iso(g.updated_at)! })),
    goal_events: goalEvents.reverse().map((e) => ({ at: iso(e.created_at)!, kind: e.kind, summary: debugText(e.summary, 160) })),
    audit: audit.reverse().map((e) => ({ at: iso(e.created_at)!, kind: e.kind })),
    jobs: jobs.map((j) => ({ kind: j.kind, status: j.status, attempts: j.attempts, problem: j.last_error ? debugText(j.last_error, 160) : null })),
    accounts: accounts.map((a) => ({ provider: a.provider, status: a.status, healthy: a.last_check_ok })),
    findings,
  };
}

// ------------------------------------------------------------------ repairs
//
// A repair is proposed first (a row, with what it will do in plain words) and
// carried out only in a LATER turn, after the person has had the chance to
// answer. None of them sends, deletes, spends or widens access: a repair that
// leads to such a thing ends at the ordinary approval card.

export class DebugRepairError extends Error {}

interface RepairRow { id: string; owner_user_id: string; thread_id: string; kind: DebugRepairKind; target_id: string | null; preview: string; state: string; created_at: string;
  result: { proposed_after_message?: string | null } | null }

export async function proposeDebugRepair(db: Db, args: { ownerUserId: string; threadId: string; kind: string; targetId?: string | null }): Promise<{ repair_id: string; what_it_does: string }> {
  let preview: string; let target: string | null = null;
  if (args.kind === 'prepare_request_again') {
    const [row] = await db.query<AssistantActionState & { is_expired: boolean }>(
      `select *, (status = 'expired' or (expires_at is not null and expires_at <= now())) as is_expired from assistant_action_states
       where owner_user_id = $1 and thread_id = $2 and id::text like $3 order by created_at desc limit 1`, [args.ownerUserId, args.threadId, `${String(args.targetId ?? '')}%`]);
    if (!row || !args.targetId) throw new DebugRepairError('There is no such request in this conversation.');
    if (!row.is_expired || row.executed_at) throw new DebugRepairError('That request has not expired, or was already carried out. There is nothing to prepare again.');
    target = row.id;
    preview = `Prepare the same ${row.domain} request again with a new approval, so a working card appears. Nothing is sent or changed until you approve that card.`;
  } else if (args.kind === 'goal_continue') {
    const [goal] = await db.query<{ id: string; state: string }>(
      `select id, state from work_goals where owner_user_id = $1 and thread_id = $2 and id::text like $3 and state not in ('completed', 'cancelled') limit 1`,
      [args.ownerUserId, args.threadId, `${String(args.targetId ?? '')}%`]);
    if (!goal || !args.targetId) throw new DebugRepairError('There is no such unfinished goal in this conversation.');
    target = goal.id;
    preview = 'Tell the goal that the step it was waiting on is done, and let it continue with its next step now. Anything it then wants to send or change still asks you first.';
  } else if (args.kind === 'run_reconcile') {
    preview = 'Run the housekeeping checks now instead of waiting for their schedule. By itself this changes nothing you would see.';
  } else throw new DebugRepairError('That is not one of the repairs the debugger may make.');
  // What the person had last written when this was proposed. Carrying it out
  // needs a newer message from them; by message, not by clock.
  const [lastSaid] = await db.query<{ id: string }>(`select id from messages where thread_id = $1 and direction = 'in' order by created_at desc, id desc limit 1`, [args.threadId]);
  const [saved] = await db.query<{ id: string }>(
    `insert into debug_repairs (owner_user_id, thread_id, kind, target_id, preview, result) values ($1, $2, $3, $4, $5, $6) returning id`,
    [args.ownerUserId, args.threadId, args.kind, target, preview, JSON.stringify({ proposed_after_message: lastSaid?.id ?? null })]);
  await appendEvent(db, { actorUserId: args.ownerUserId, actor: 'agent', kind: 'debug.repair_proposed', subjectType: 'thread', subjectId: args.threadId,
    payload: { repairId: saved!.id, kind: args.kind } });
  return { repair_id: saved!.id, what_it_does: preview };
}

/** Carries out a proposed repair. Refused until the person has written
 * something after it was proposed: a repair is never proposed and made in the
 * same breath. */
export async function runDebugRepair(db: Db, args: { ownerUserId: string; threadId: string; repairId: string }): Promise<Record<string, unknown>> {
  const [repair] = await db.query<RepairRow>(
    `select * from debug_repairs where owner_user_id = $1 and thread_id = $2 and id::text like $3 order by created_at desc limit 1`,
    [args.ownerUserId, args.threadId, `${args.repairId}%`]);
  if (!repair) throw new DebugRepairError('There is no such proposed repair in this conversation.');
  if (repair.state !== 'proposed') throw new DebugRepairError('That repair was already carried out or has failed. Investigate again before proposing another.');
  const [lastSaid] = await db.query<{ id: string }>(`select id from messages where thread_id = $1 and direction = 'in' order by created_at desc, id desc limit 1`, [args.threadId]);
  const answered = !!lastSaid && lastSaid.id !== (repair.result?.proposed_after_message ?? null);
  if (!answered) throw new DebugRepairError('The person has not answered since this repair was proposed. Tell them what it will do and wait for their yes.');
  const claimed = await db.query(`update debug_repairs set state = 'done', done_at = now() where id = $1 and state = 'proposed' returning id`, [repair.id]);
  if (!claimed.length) throw new DebugRepairError('That repair was already carried out.');

  let result: Record<string, unknown>;
  try {
    if (repair.kind === 'prepare_request_again') {
      const [old] = await db.query<AssistantActionState>('select * from assistant_action_states where id = $1 and owner_user_id = $2', [repair.target_id, args.ownerUserId]);
      const again = old ? await prepareActionAgain(db, old) : null;
      if (!again) throw new DebugRepairError('That request could not be prepared again.');
      // Shaped like any freshly prepared request, so every client draws its card.
      result = { ok: true, repaired: 'prepare_request_again', state: 'prepared', task_id: again.task.id, approval_id: again.approval.id,
        summary: again.approval.summary, action: again.approval.action, action_class: again.approval.action_class, expires_at: again.approval.expires_at };
    } else if (repair.kind === 'goal_continue') {
      const [goal] = await db.query<{ revision: number }>('select revision from work_goals where id = $1 and owner_user_id = $2', [repair.target_id, args.ownerUserId]);
      if (!goal) throw new DebugRepairError('That goal is gone.');
      const [done] = await db.query<{ domain: string; executed_at: string }>(
        `select domain, executed_at from assistant_action_states where owner_user_id = $1 and thread_id = $2 and status = 'succeeded' order by executed_at desc limit 1`,
        [args.ownerUserId, args.threadId]);
      const fact = done ? `The ${done.domain} request this goal was waiting for was approved and carried out at ${iso(done.executed_at)}.` : 'The step this goal was waiting on has been dealt with.';
      const snapshot = await controlWorkGoal(db, { ownerUserId: args.ownerUserId, goalId: repair.target_id!, revision: goal.revision, action: 'resume',
        instruction: `${fact} Treat that step as done and do not ask for its approval again. Continue with the next step. When something comes back that the person would want to talk about, say it and wait for them.` });
      result = { ok: true, repaired: 'goal_continue', goal_state: snapshot.state };
    } else {
      await enqueue(db, { kind: 'work-goals.reconcile' });
      result = { ok: true, repaired: 'run_reconcile' };
    }
  } catch (error) {
    await db.query(`update debug_repairs set state = 'failed', result = $2 where id = $1`, [repair.id, JSON.stringify({ error: debugText(error instanceof Error ? error.message : error, 200) })]);
    throw error instanceof DebugRepairError ? error : new DebugRepairError(error instanceof Error ? error.message : 'The repair failed.');
  }
  await db.query(`update debug_repairs set result = $2 where id = $1`, [repair.id, JSON.stringify(result)]);
  await appendEvent(db, { actorUserId: args.ownerUserId, actor: 'agent', kind: 'debug.repair_done', subjectType: 'thread', subjectId: args.threadId,
    payload: { repairId: repair.id, kind: repair.kind } });
  return result;
}

/** Files the handoff she wrote with the newest case of this conversation. */
export async function saveDebugHandoff(db: Db, args: { ownerUserId: string; threadId: string; title: string; markdown: string }): Promise<{ case_id: string } | null> {
  const [row] = await db.query<{ id: string }>(
    `update debug_cases set handoff_title = $3, handoff = $4 where id = (
       select id from debug_cases where owner_user_id = $1 and thread_id = $2 order by created_at desc limit 1) returning id`,
    [args.ownerUserId, args.threadId, args.title.slice(0, 200), args.markdown.slice(0, 200_000)]);
  if (!row) return null;
  await appendEvent(db, { actorUserId: args.ownerUserId, actor: 'agent', kind: 'debug.handoff_written', subjectType: 'thread', subjectId: args.threadId, payload: { caseId: row.id } });
  return { case_id: row.id };
}
