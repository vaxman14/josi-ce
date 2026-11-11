// Parental Controls at the turn, which is the layer that covers every channel.
//
// The web route refuses a blocked child itself, so that a browser gets a plain
// 403 and a sentence. This is the OTHER layer, and it is the one that matters
// for Telegram, WhatsApp, Slack and Signal — none of which go through that
// route. A future channel that forgets to ask is still refused here.
//
// Two things are asserted that a coarser test would miss:
//
//   * the check runs BEFORE the model is even looked up, so a household with
//     no model configured still gets "outside your hours" rather than "no
//     model", and a blocked turn spends nothing;
//   * an allowed turn records its minute before anything can fail, because the
//     minute somebody spoke is the minute that was used.
import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { testDb, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { ensureWorkspace } from '../../core/src/workspace.js';
import { activateEntitlement } from '../../core/src/entitlements.js';
import { createLink, normalizeBlockedTopics, normalizeWindows, setControls } from '../../core/src/parental.js';
import { MasterKey } from '../../core/src/masterKey.js';
import { seal } from '../../core/src/index.js';
import { testVault } from '../../core/test/helpers.js';
import { createThread } from '../../core/src/conversations.js';
import { runAssistantTurn } from '../src/assistantAgent.js';

const keys = generateKeyPairSync('ed25519');
const PUBLISHER_KEY = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64');

function license(): string {
  const payload = Buffer.from(JSON.stringify({
    v: 1, licenseId: 'JOSI-PC-1', module: 'parental_controls', issuedTo: 'A household',
    installId: null, issuedAt: '2026-01-01T00:00:00.000Z', expiresAt: null,
  })).toString('base64url');
  return `josi-lic.1.${payload}.${sign(null, Buffer.from(`josi-lic.1.${payload}`, 'utf8'), keys.privateKey).toString('base64url')}`;
}

let db: TestDb;
const ids: Record<string, string> = {};

beforeEach(async () => {
  db = await testDb();
  await ensureWorkspace(db);
  ids.parent = (await createUser(db, { email: 'p@ce.test', username: 'parent', role: 'super_admin' })).id;
  ids.child = (await createUser(db, { email: 'c@ce.test', username: 'child', role: 'member' })).id;
  await activateEntitlement(db, {
    module: 'parental_controls', token: license(), publicKey: PUBLISHER_KEY, actorUserId: ids.parent,
  });
  await createLink(db, { parentUserId: ids.parent, childUserId: ids.child, actorUserId: ids.parent });
  ids.thread = (await createThread(db, { ownerUserId: ids.child })).id;
});

const turn = (userId: string, channel?: 'web' | 'telegram' | 'external') => runAssistantTurn({
  db,
  registry: { db, masterKey: null },
  userId,
  threadId: ids.thread,
  history: [],
  inbound: 'are you there?',
  channel,
});

describe('every channel goes through the same door', () => {
  it('refuses a child outside their hours before it looks for a model', async () => {
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, timezone: 'UTC', scheduleEnabled: true, windows: [],
    });
    const result = await turn(ids.child, 'telegram');
    // Not 'no_model', which is what this installation would say to anybody
    // else — the order of the two checks is the assertion.
    expect(result.refusal?.reason).toBe('restricted');
    expect(result.refusal?.message).toMatch(/outside your agreed hours/i);
    const [minutes] = await db.query<{ n: string }>(
      `select count(*) as n from child_activity_minutes where child_user_id = $1`, [ids.child],
    );
    expect(Number(minutes.n)).toBe(0);
  });

  it('refuses a child who has spent the day, whatever the channel', async () => {
    await setControls(db, { childUserId: ids.child, actorUserId: ids.parent, timezone: 'UTC', dailyLimitMinutes: 5 });
    for (let i = 1; i <= 5; i += 1) {
      await db.query(
        `insert into child_activity_minutes (child_user_id, minute, channel)
         values ($1, date_trunc('minute', now()) - make_interval(mins => $2), 'external') on conflict do nothing`,
        [ids.child, i],
      );
    }
    expect((await turn(ids.child, 'external')).refusal?.reason).toBe('restricted');
  });

  it('counts the minute of an allowed turn, on the channel it came in on', async () => {
    const result = await turn(ids.child, 'telegram');
    // No model is configured here, so the honest refusal is about the model —
    // which is the proof the parental door was open.
    expect(result.refusal?.reason).toBe('no_model');
    const rows = await db.query<{ channel: string }>(
      `select channel from child_activity_minutes where child_user_id = $1`, [ids.child],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe('telegram');
  });

  it('counts nothing at all for somebody who is not a managed child', async () => {
    const result = await turn(ids.parent);
    expect(result.refusal?.reason).toBe('no_model');
    const [minutes] = await db.query<{ n: string }>(`select count(*) as n from child_activity_minutes`);
    expect(Number(minutes.n)).toBe(0);
  });
});

// Blocked topics are an INSTRUCTION to the model on the child's own turn. The
// stub model below returns nothing of interest; what is asserted is the system
// context that reached it, for the child and for nobody else.
describe('topics a parent turned off reach the model on the child’s turn only', () => {
  const key = new MasterKey(Buffer.alloc(32, 43));
  let lastSystem = '';
  const captureFetch: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body ?? '{}'));
    const system = (body.messages ?? []).find((m: { role: string }) => m.role === 'system');
    lastSystem = system?.content ?? body.system ?? '';
    return new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const modelTurn = (userId: string) => runAssistantTurn({
    db, registry: { db, masterKey: key, fetchImpl: captureFetch, resolve: async () => ['203.0.113.10'] },
    userId, threadId: ids.thread, history: [], inbound: 'tell me about casinos',
  });

  beforeEach(async () => {
    lastSystem = '';
    await testVault(db, key);
    await db.query(
      `insert into llm_providers
         (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
          cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
       values ('primary', 'openai', 'gpt-test', $1, true, now(), now(), true, true, false, 8000)`,
      [seal(key, { apiKey: 'k' })],
    );
  });

  it('tells the model which topics are off, and how to say so', async () => {
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent,
      blockedTopics: normalizeBlockedTopics(['gambling', 'horror\nfilms']),
    });
    const result = await modelTurn(ids.child);
    expect(result.refusal).toBeUndefined();
    expect(lastSystem).toContain('A PARENT HAS TURNED SOME TOPICS OFF');
    expect(lastSystem).toContain('- gambling');
    // A line break inside a topic cannot start a line of its own.
    expect(lastSystem).toContain('- horror films');
    expect(lastSystem).toMatch(/a parent has turned that topic off/i);
    expect(lastSystem).toMatch(/never list, hint at or confirm the other topics/i);
  });

  it('says nothing of the kind to the parent, or to a child with no topics off', async () => {
    await setControls(db, {
      childUserId: ids.child, actorUserId: ids.parent, blockedTopics: normalizeBlockedTopics(['gambling']),
    });
    await modelTurn(ids.parent);
    expect(lastSystem).not.toBe('');
    expect(lastSystem).not.toContain('TOPICS OFF');
    expect(lastSystem).not.toContain('gambling');

    await setControls(db, { childUserId: ids.child, actorUserId: ids.parent, blockedTopics: [] });
    await modelTurn(ids.child);
    expect(lastSystem).not.toBe('');
    expect(lastSystem).not.toContain('TOPICS OFF');
  });
});
