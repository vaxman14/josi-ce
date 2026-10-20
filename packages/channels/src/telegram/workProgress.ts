import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, type Db, type MasterKey, type WorkGoalStep } from '@josi-ce/core';
import type { Continuation, GoalProgress } from '@josi-ce/protocol';
import { loadConfig, openToken } from './config.js';
import { TelegramApiError, TelegramBotApi } from './api.js';

interface Progress {
  goal_id: string; owner_user_id: string; link_id: string; bot_id: string; chat_id: string;
  message_id: string | null; last_sent_revision: number; content_digest: string | null;
  revision: number; state: GoalProgress['state']; outcome: string; activity: string;
  steps: WorkGoalStep[]; continuation: Continuation | null; attempt_id: string;
}
const labels: Record<string, string> = { planning: 'Planning', working: 'In progress', waiting: 'Waiting',
  needs_instruction: 'Needs your instructions', paused: 'Paused', verifying: 'Needs outcome confirmation',
  completed: 'Completed', cancelled: 'Cancelled' };
function short(value: string, limit: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, ' ').trim();
  const points = Array.from(clean);
  return points.length <= limit ? clean : points.slice(0, limit - 1).join('') + '…';
}
/** Deliberately bounded summary, with truncation visible and full details in
 * Josi. No checkpoint facts, private tool receipts, screenshots or Vault data. */
export function telegramWorkSummary(goal: Pick<Progress, 'steps' | 'state' | 'outcome' | 'activity' | 'continuation'>): string {
  const lines = [`${goal.steps.filter(step => step.state === 'verified').length}/${goal.steps.length} steps verified`,
    `${labels[goal.state] ?? 'Unfinished'} · ${short(goal.outcome, 180)}`, ''];
  const shown = goal.steps.slice(0, 10);
  for (const step of shown) lines.push(`${step.state === 'verified' ? '[✓]' : '[ ]'} ${short(step.title, 100)}${step.state === 'working' ? ' (in progress)' : step.state === 'blocked' ? ' (waiting)' : ''}`);
  if (goal.steps.length > shown.length) lines.push(`… ${goal.steps.length - shown.length} more steps in Josi`);
  lines.push('', short(goal.activity, 220));
  if (goal.continuation?.kind === 'question') lines.push('', short(goal.continuation.text, 500));
  else if (goal.continuation?.kind === 'wait') lines.push('', short(goal.continuation.reason, 220), `Next check: ${goal.continuation.wakeAt}`);
  lines.push('', 'Full plan, evidence and controls: Josi → Tasks');
  const body = lines.join('\n');
  if (body.length > 4096) throw new Error('The progress summary exceeds the channel limit.');
  return body;
}
function integer(value: unknown): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('The channel receipt is invalid.');
  return number;
}

/** Coalesce changed goals into one updating message in their ORIGINAL private
 * Telegram chat. This function is a worker adapter, never an agent send tool. */
export async function deliverTelegramWorkProgress(db: Db, args: {
  key: MasterKey; fetchImpl?: typeof fetch;
}): Promise<number> {
  if (!db.transaction) throw new Error('Durable progress delivery requires transactions.');
  const config = await loadConfig(db);
  if (!config?.enabled || !config.bot_token_enc || !config.bot_id) return 0;
  // Resolve current Vault credentials before claiming any irreversible send.
  await openToken(db, args.key, config);
  await db.query(`insert into telegram_work_progress(goal_id,owner_user_id,link_id,bot_id,chat_id)
    select g.id,g.owner_user_id,l.id,$1,l.chat_id from work_goals g
      join messages m on m.id=g.source_message_id and m.thread_id=g.thread_id and m.channel='telegram'
      join telegram_links l on l.id::text=m.meta->>'telegram_link_id' and l.user_id=g.owner_user_id
        and l.thread_id=g.thread_id and l.status='active'
      join users u on u.id=g.owner_user_id and u.status='active'
      where m.meta->>'telegram_bot_id'=$1 and (g.state not in ('completed','cancelled') or g.updated_at>now()-interval '1 day')
      on conflict(goal_id) do nothing`, [String(config.bot_id)]);
  // Crash/lost response is visible and never turns into a second first-send.
  await db.query(`update telegram_work_progress set state='uncertain',error_code='delivery_interrupted',updated_at=now()
    where state='sending' and started_at<now()-interval '2 minutes'`);
  let sent = 0;
  for (let index = 0; index < 3; index++) {
    const attemptId = randomUUID();
    const row = await db.transaction(async tx => {
      const [candidate] = await tx.query<Progress>(`select p.goal_id,p.owner_user_id,p.link_id,p.bot_id,p.chat_id,p.message_id,
        p.last_sent_revision,p.content_digest,g.revision,g.state,g.outcome,g.activity,g.steps,g.continuation
        from telegram_work_progress p join work_goals g on g.id=p.goal_id and g.owner_user_id=p.owner_user_id
        join telegram_links l on l.id=p.link_id and l.user_id=p.owner_user_id and l.chat_id=p.chat_id and l.thread_id=g.thread_id and l.status='active'
        join users u on u.id=p.owner_user_id and u.status='active'
        join threads t on t.id=g.thread_id and t.owner_user_id=p.owner_user_id and t.status='open'
        where p.state in ('ready','sent') and p.bot_id=$1 and p.next_attempt_at<=now() and p.last_sent_revision<g.revision
          and not exists(select 1 from telegram_work_progress recent where recent.link_id=p.link_id
            and (recent.state='sending' or recent.started_at>now()-interval '10 seconds'))
        order by p.updated_at,p.goal_id for update of p,l skip locked limit 1`, [String(config.bot_id)]);
      if (!candidate) return null;
      const [busy] = await tx.query(`select 1 from telegram_work_progress where link_id=$1
        and (state='sending' or started_at>now()-interval '10 seconds') limit 1`, [candidate.link_id]);
      if (busy) return null;
      await tx.query(`update telegram_work_progress set state='sending',attempt_id=$2,started_at=now(),updated_at=now() where goal_id=$1`,
        [candidate.goal_id, attemptId]);
      return { ...candidate, attempt_id: attemptId };
    });
    if (!row) break;
    let crossed = false;
    try {
      const current = await loadConfig(db);
      const [linked] = await db.query(`select 1 from telegram_links l join users u on u.id=l.user_id
        join work_goals g on g.id=$4 and g.owner_user_id=l.user_id and g.thread_id=l.thread_id
        join threads t on t.id=g.thread_id and t.owner_user_id=l.user_id and t.status='open'
        where l.id=$1 and l.user_id=$2 and l.chat_id=$3 and l.status='active' and u.status='active'`,
        [row.link_id, row.owner_user_id, row.chat_id, row.goal_id]);
      if (!linked || !current?.enabled || current.bot_id !== config.bot_id || current.bot_token_enc !== config.bot_token_enc) {
        await db.query(`update telegram_work_progress set state='disabled',error_code='channel_changed',updated_at=now()
          where goal_id=$1 and attempt_id=$2`, [row.goal_id, attemptId]);
        continue;
      }
      const body = telegramWorkSummary(row), digest = createHash('sha256').update(body).digest('hex');
      let messageId = row.message_id ? integer(row.message_id) : null;
      if (!messageId || row.content_digest !== digest) {
        const api = new TelegramBotApi({ token: await openToken(db, args.key, current), fetchImpl: args.fetchImpl });
        crossed = true;
        try {
          const result = messageId
            ? await api.editMessageText({ chatId: integer(row.chat_id), messageId, text: body })
            : await api.sendMessage({ chatId: integer(row.chat_id), text: body, parseMode: null });
          const returned = integer(result.message_id);
          if (messageId !== null && messageId !== returned) throw new Error('The channel receipt changed.');
          messageId = returned;
        } catch (error) {
          if (!(messageId && error instanceof TelegramApiError && error.category === 'not_modified')) throw error;
        }
      }
      await db.transaction(async tx => {
        const saved = await tx.query(`update telegram_work_progress set state='sent',message_id=$3,last_sent_revision=$4,content_digest=$5,
          error_code=null,next_attempt_at=now()+interval '10 seconds',updated_at=now() where goal_id=$1 and attempt_id=$2 and state='sending' returning goal_id`,
          [row.goal_id, attemptId, messageId, row.revision, digest]);
        if (!saved.length) throw new Error('The progress delivery claim changed.');
        await appendEvent(tx, { actorUserId: row.owner_user_id, actor: 'system', kind: 'work.telegram_progress_sent',
          subjectType: 'work_goal', subjectId: row.goal_id, payload: { revision: row.revision, transmitted: crossed, edited: crossed && row.message_id !== null } });
      });
      sent++;
    } catch (error) {
      const category = error instanceof TelegramApiError ? error.category : crossed ? 'delivery_unknown' : 'unavailable';
      const rateLimited = category === 'rate_limited';
      // Only an explicit refusal to send can be retried. Timeouts, crashes and
      // ambiguous responses remain uncertain; no blind duplicate notification.
      const wait = error instanceof TelegramApiError && Number.isFinite(error.retryAfterSeconds)
        ? Math.max(10, Math.min(86400, error.retryAfterSeconds!)) : 30;
      const state = rateLimited || !crossed ? 'ready'
        : ['network', 'malformed', 'unknown', 'delivery_unknown'].includes(category) ? 'uncertain' : 'failed';
      await db.query(`update telegram_work_progress set state=$3,error_code=$4,next_attempt_at=now()+$5*interval '1 second',updated_at=now()
        where goal_id=$1 and attempt_id=$2 and state='sending'`, [row.goal_id, attemptId, state, category, wait]);
      if (['blocked_by_user', 'chat_not_found'].includes(category)) await db.query(`update telegram_links
        set status='revoked',revoked_at=now() where id=$1 and user_id=$2 and status='active'`, [row.link_id, row.owner_user_id]);
    }
  }
  return sent;
}
