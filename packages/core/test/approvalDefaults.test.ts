// LB10 — the approval policy fails closed.
//
// The defect these tests exist for: `admin_approval_policy` with no row meant
// no ceiling. `getApprovalLevel` read a missing row as `automatic`, so a fresh
// installation had a fail-OPEN ceiling sitting underneath a fail-closed user
// default. It looked safe, and every existing test agreed with it, because
// nobody asked what happened when a user chose `automatic` for themselves.
import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testDb, type TestDb } from './helpers.js';
import { createUser } from '../../auth/src/users.js';
import {
  ACTION_CLASSES, ApprovalError, DEFAULT_ADMIN_CEILING,
  acknowledgePolicyMigration, actionClassSpec, effectiveApprovalLevel, getApprovalLevel,
  isHighImpactClass, isRelaxation, isRiskyAction, needsApproval, pendingPolicyMigration,
  setAdminApprovalCeiling, setUserApprovalLevel,
  type ApprovalLevel,
} from '../src/index.js';

let db: TestDb;
let admin: string;
let member: string;

beforeEach(async () => {
  db = await testDb();
  admin = (await createUser(db, { email: 'admin@ce.test', username: 'admin', role: 'super_admin' })).id;
  member = (await createUser(db, { email: 'm@ce.test', username: 'member', role: 'member' })).id;
});

describe('LB10.1 — a fresh installation fails closed', () => {
  it('does not treat "no policy" as "no ceiling"', () => {
    expect(DEFAULT_ADMIN_CEILING).toBe('always_ask');
    // The exact expression that was wrong. With no admin policy at all, a user
    // who chose the loosest setting available to them still gets asked.
    expect(effectiveApprovalLevel('automatic', null)).toBe('always_ask');
    expect(effectiveApprovalLevel('risky_only', null)).toBe('always_ask');
  });

  it('caps a member who chose automatic, on a database nobody has configured', async () => {
    await setUserApprovalLevel(db, { userId: member, actionClass: 'email_send', level: 'automatic' });
    const level = await getApprovalLevel(db, { userId: member, actionClass: 'email_send' });
    expect(level.userChoice).toBe('automatic');
    expect(level.adminCeiling).toBe('always_ask');
    expect(level.level).toBe('always_ask');
  });

  it('seeds an explicit ceiling for every action class', async () => {
    const rows = await db.query<{ action_class: string; max_level: string }>(
      `select action_class, max_level from admin_approval_policy order by action_class`,
    );
    expect(rows.map((r) => r.action_class).sort())
      .toEqual(ACTION_CLASSES.map((c) => c.key).sort());
    for (const row of rows) {
      expect(row.max_level, row.action_class).toBe('always_ask');
    }
  });
});

describe('LB10.2 — the ordinary actions are gated on a fresh install', () => {
  for (const actionClass of ['email_send', 'calendar_write', 'task_management']) {
    it(`requires approval for ${actionClass} even if the user asked for automatic`, async () => {
      await setUserApprovalLevel(db, { userId: member, actionClass, level: 'automatic' });
      // A generic action in the class — not one of the named risky ones, so
      // this is the ceiling doing the work and nothing else.
      expect(await needsApproval(db, { userId: member, actionClass, action: 'do_the_thing' })).toBe(true);
    });
  }
});

describe('LB10.3 — high-impact actions get the strictest treatment', () => {
  const HIGH = [
    'delete_data', 'cancel_commitment', 'invite_external',
    'publish_public', 'spend_money', 'sign_agreement', 'change_access',
  ];

  it('names every one of them high impact', () => {
    for (const key of HIGH) {
      expect(actionClassSpec(key), key).toBeTruthy();
      expect(isHighImpactClass(key), key).toBe(true);
    }
  });

  it('asks about them even when the ceiling has been opened all the way', async () => {
    for (const actionClass of HIGH) {
      await setAdminApprovalCeiling(db, {
        actorUserId: admin, actionClass, maxLevel: 'automatic', confirmRelaxation: true,
      });
      await setUserApprovalLevel(db, { userId: member, actionClass, level: 'automatic' });
      // Both the ceiling and the user's own preference say "don't ask". The
      // class impact is a floor underneath both, so an action nobody thought to
      // add to ALWAYS_RISKY is still asked about.
      expect(
        await needsApproval(db, { userId: member, actionClass, action: 'some_new_verb' }),
        actionClass,
      ).toBe(true);
    }
  });

  it('keeps the named risky actions risky', () => {
    for (const action of [
      'add_recipient', 'send_attachment', 'delete_data', 'spend_money',
      'cancel_commitment', 'invite_external', 'publish_public', 'sign_agreement', 'change_access',
    ]) {
      expect(isRiskyAction(action), action).toBe(true);
    }
  });
});

describe('LB10.4 — the ceiling still only tightens', () => {
  it('is the stricter of the two, for every combination', () => {
    const levels: ApprovalLevel[] = ['always_ask', 'risky_only', 'automatic'];
    const rank = { always_ask: 0, risky_only: 1, automatic: 2 };
    for (const user of levels) {
      for (const ceiling of levels) {
        const effective = effectiveApprovalLevel(user, ceiling);
        expect(rank[effective], `${user} x ${ceiling}`).toBe(Math.min(rank[user], rank[ceiling]));
      }
    }
  });

  it('cannot be widened past the ceiling by a user preference', async () => {
    await setAdminApprovalCeiling(db, { actorUserId: admin, actionClass: 'email_send', maxLevel: 'always_ask' });
    await setUserApprovalLevel(db, { userId: member, actionClass: 'email_send', level: 'automatic' });
    expect((await getApprovalLevel(db, { userId: member, actionClass: 'email_send' })).level).toBe('always_ask');
  });
});

describe('LB10.5 — relaxing is deliberate and recorded', () => {
  it('refuses a relaxation that was not confirmed', async () => {
    await expect(
      setAdminApprovalCeiling(db, { actorUserId: admin, actionClass: 'email_send', maxLevel: 'automatic' }),
    ).rejects.toBeInstanceOf(ApprovalError);

    // And nothing was written.
    const [row] = await db.query<{ max_level: string }>(
      `select max_level from admin_approval_policy where action_class = 'email_send'`,
    );
    expect(row.max_level).toBe('always_ask');
  });

  it('allows a tightening without any confirmation', async () => {
    await setAdminApprovalCeiling(db, {
      actorUserId: admin, actionClass: 'email_send', maxLevel: 'automatic', confirmRelaxation: true,
    });
    // Going back the other way is a restriction, so it needs no ceremony.
    const result = await setAdminApprovalCeiling(db, {
      actorUserId: admin, actionClass: 'email_send', maxLevel: 'always_ask',
    });
    expect(result.relaxed).toBe(false);
    expect(result.previous).toBe('automatic');
  });

  it('records who relaxed what, and to what, as its own event kind', async () => {
    await setAdminApprovalCeiling(db, {
      actorUserId: admin, actionClass: 'email_send', maxLevel: 'risky_only', confirmRelaxation: true,
    });
    const [event] = await db.query<{ actor_user_id: string; payload: any }>(
      `select actor_user_id, payload from events where kind = 'approval.ceiling_relaxed'`,
    );
    expect(event).toBeTruthy();
    expect(event.actor_user_id).toBe(admin);
    expect(event.payload.actionClass).toBe('email_send');
    expect(event.payload.previousMaxLevel).toBe('always_ask');
    expect(event.payload.maxLevel).toBe('risky_only');
  });

  it('answers the relaxation question consistently', () => {
    expect(isRelaxation('always_ask', 'automatic')).toBe(true);
    expect(isRelaxation('always_ask', 'risky_only')).toBe(true);
    expect(isRelaxation('automatic', 'always_ask')).toBe(false);
    expect(isRelaxation('risky_only', 'risky_only')).toBe(false);
    // No stored policy is treated as the fail-closed default, not as automatic,
    // so setting anything looser than always_ask on a fresh class is still a
    // relaxation and still has to be confirmed.
    expect(isRelaxation(null, 'automatic')).toBe(true);
    expect(isRelaxation(null, 'always_ask')).toBe(false);
  });

  it('refuses a class it does not know about', async () => {
    await expect(
      setAdminApprovalCeiling(db, { actorUserId: admin, actionClass: 'made_up', maxLevel: 'always_ask' }),
    ).rejects.toBeInstanceOf(ApprovalError);
  });
});

describe('LB10.7 — the migration is safe and visible', () => {
  it('reports every ceiling it seeded, so the narrowing is not silent', async () => {
    const pending = await pendingPolicyMigration(db);
    expect(pending.map((p) => p.action_class).sort()).toEqual(ACTION_CLASSES.map((c) => c.key).sort());
    for (const row of pending) {
      expect(row.previous_max_level, `${row.action_class} had no previous policy`).toBeNull();
      expect(row.new_max_level).toBe('always_ask');
      expect(row.reason).toContain('no ceiling at all');
    }
  });

  it('stops reporting once an administrator has read it', async () => {
    expect(await acknowledgePolicyMigration(db, admin)).toBe(ACTION_CLASSES.length);
    expect(await pendingPolicyMigration(db)).toEqual([]);
    // Acknowledging nothing is not an event.
    expect(await acknowledgePolicyMigration(db, admin)).toBe(0);
  });

  it('never overwrites a policy an administrator already chose', async () => {
    // Re-running the migration is the case that matters: an operator upgrading
    // twice, or a migration runner that is not perfectly exactly-once.
    await setAdminApprovalCeiling(db, {
      actorUserId: admin, actionClass: 'email_send', maxLevel: 'risky_only', confirmRelaxation: true,
    });
    await acknowledgePolicyMigration(db, admin);

    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations/0016_approval_defaults.sql'),
      'utf8',
    );
    await db.exec(sql);

    const [row] = await db.query<{ max_level: string }>(
      `select max_level from admin_approval_policy where action_class = 'email_send'`,
    );
    expect(row.max_level, 'a deliberate choice survived the migration').toBe('risky_only');
    // And re-running logged nothing new, because it changed nothing.
    expect(await pendingPolicyMigration(db)).toEqual([]);
  });
});

describe('LB10 — the catalog and the migration agree', () => {
  it('seeds exactly the classes the code knows about', () => {
    // Two lists of the same thing in two languages is a drift waiting to
    // happen: a class added to the catalog with no seeded row would silently
    // fall back to the default instead of appearing in the migration report.
    const sql = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations/0016_approval_defaults.sql'),
      'utf8',
    );
    const seeded = [...sql.matchAll(/\('([a-z_]+)',\s*'(always_ask|risky_only|automatic)'\)/g)]
      .map((m) => ({ key: m[1], level: m[2] }));
    expect(seeded.map((s) => s.key).sort()).toEqual(ACTION_CLASSES.map((c) => c.key).sort());
    for (const spec of ACTION_CLASSES) {
      expect(seeded.find((s) => s.key === spec.key)?.level, spec.key).toBe(spec.factoryCeiling);
    }
  });

  it('has no class whose factory ceiling is anything but always ask', () => {
    for (const spec of ACTION_CLASSES) {
      expect(spec.factoryCeiling, spec.key).toBe('always_ask');
    }
  });
});
