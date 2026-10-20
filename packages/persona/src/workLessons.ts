import { appendEvent, type Db } from '@josi-ce/core';
import { MemoryError, refuseSecret } from './memory.js';

/** A model can propose a lesson, never approve it or write a permission. The
 * evidence is resolved from owned, completed work rather than model-supplied
 * receipt IDs. Work lessons always go through the existing review inbox. */
export async function suggestWorkLesson(db: Db, args: { ownerUserId: string; goalId: string; content: string }) {
  const content = args.content.trim();
  if (!content || content.length > 2000) throw new MemoryError('Write a lesson of at most 2,000 characters.');
  if (refuseSecret(content)) throw new MemoryError('Keep credentials in the Vault, not in a lesson.');
  if (!/^[0-9a-f-]{36}$/i.test(args.goalId)) throw new MemoryError('Work item not found.');
  if (!db.transaction) throw new MemoryError('Durable lesson review is unavailable.');
  return db.transaction(async tx => {
    const [goal] = await tx.query<{ id: string; revision: number; state: string; source_message_id: string }>(
      `select id,revision,state,source_message_id from work_goals where id=$1 and owner_user_id=$2 for share`, [args.goalId, args.ownerUserId]);
    if (!goal) throw new MemoryError('Work item not found.');
    if (goal.state !== 'completed') throw new MemoryError('Confirm the completed outcome before proposing a reusable lesson.');
    const [settings] = await tx.query<{ memory_mode: string }>(`select memory_mode from persona_settings where user_id=$1`, [args.ownerUserId]);
    if (settings?.memory_mode === 'off') return { proposed: false, reason: 'Memory is switched off.' };
    const rows = await tx.query<{ id: string }>(`insert into memory_suggestions(owner_user_id,content,source_kind,source_id,confidence,work_goal_id,work_goal_revision)
      values($1,$2,'conversation',$3,0.6,$4,$5) on conflict(owner_user_id,work_goal_id) where work_goal_id is not null do nothing returning id`,
      [args.ownerUserId, content, goal.source_message_id, goal.id, goal.revision]);
    if (!rows.length) return { proposed: false, reason: 'A lesson from this work has already been proposed or reviewed.' };
    // Only IDs and revision in the shared audit stream. The lesson stays in
    // the existing private memory review table.
    await appendEvent(tx, { actorUserId: args.ownerUserId, actor: 'agent', kind: 'memory.work_lesson_proposed',
      subjectType: 'memory', subjectId: rows[0].id, payload: { goalId: goal.id, revision: goal.revision } });
    return { proposed: true, suggestionId: rows[0].id, requiresOwnerReview: true };
  });
}
