// Memory that works like a clock: what each turn is GIVEN about the past.
//
// The model is a stand-in that records what reached it and answers with a
// scripted reply. These tests assert on what Josi received, not on prose:
// follow-ups like "try again", long conversations, earlier conversations,
// facts the person stated, corrections, approved skills and their rollback.
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { MasterKey, seal } from '@josi-ce/core';
import { runAssistantTurn } from '../src/assistantAgent.js';
import {
  conversationHistory, createRecall, fitHistory, historyContent, searchOwnHistory, summarizeThread, SUMMARY_LABEL,
} from '../src/memoryEngine.js';
import {
  announceProposals, decideProposal, firstJson, learnFromTurn, loadGuidance, recordTurnInsights, reviewInsights, rollbackSkill, validateProposal,
} from '../src/improvementEngine.js';
import { ALL_TOOLS } from '../src/tools.js';

const key = new MasterKey(Buffer.alloc(32, 43));
const resolve = async () => ['203.0.113.10'];
let db: TestDb;
const ids: Record<string, string> = {};
const threads: Record<string, string> = {};

let scripted = 'ok';
let lastSystem = '';
let lastUser = '';
let allUser = '';
const fetchImpl: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String((init as RequestInit).body ?? '{}'));
  const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
  lastSystem = messages.find(m => m.role === 'system')?.content ?? '';
  lastUser = messages.filter(m => m.role !== 'system').map(m => `${m.role}: ${m.content}`).join('\n---\n');
  allUser += lastUser;
  return new Response(JSON.stringify({ choices: [{ message: { content: scripted } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};
const registry = () => ({ db, masterKey: key, fetchImpl, resolve });
const toolNames = ALL_TOOLS.map(t => t.def.name);

async function message(threadId: string, direction: 'in' | 'out', body: string, at: string, meta: Record<string, unknown> = {}) {
  const [row] = await db.query<{ id: string }>(`insert into messages(thread_id,direction,channel,body,meta,created_at) values($1,$2,'native',$3,$4,$5) returning id`,
    [threadId, direction, body, JSON.stringify(meta), at]);
  return row.id;
}

beforeAll(async () => {
  db = await testDb();
  for (const [name, role] of [['roman', 'super_admin'], ['guest', 'member']] as const) {
    const [u] = await db.query<{ id: string }>(`insert into users (email, username, role) values ($1, $2, $3) returning id`, [`${name}@example.test`, name, role]);
    ids[name] = u.id;
  }
  await testVault(db, key);
  await db.query(`insert into llm_providers (role, provider, model, api_key_enc, external_acknowledged, activated_at, probed_at,
      cap_chat, cap_structured_output, cap_tool_calling, cap_context_tokens)
    values ('primary', 'openai', 'gpt-test', $1, true, now(), now(), true, true, false, 8000)`, [seal(key, { apiKey: 'k' })]);
  for (const [name, owner] of [['photos', 'roman'], ['older', 'roman'], ['other', 'guest']] as const) {
    const [t] = await db.query<{ id: string }>(`insert into threads(owner_user_id,title) values($1,$2) returning id`, [ids[owner], name]);
    threads[name] = t.id;
  }
});

beforeEach(async () => {
  scripted = 'ok'; lastSystem = ''; lastUser = ''; allUser = '';
  for (const table of ['messages', 'thread_summaries', 'memory_suggestions', 'memories', 'persona_settings', 'assistant_insights',
    'memory_rules', 'assistant_skills', 'improvement_proposals']) await db.query(`delete from ${table}`);
});

describe('what Josi did is part of the conversation', () => {
  it('an earlier reply carries which tools ran and which failed, so "try again" has a referent', () => {
    const text = historyContent({ direction: 'out', body: 'Photo 1 is an HP tower.', meta: {}, tool_receipts: [
      { tool: 'browser_read_page', result: { ok: true } },
      { tool: 'browser_view_photo', result: { ok: false, code: 'command_not_verified' } },
    ] });
    expect(text).toContain('browser_read_page: done');
    expect(text).toContain('browser_view_photo: did not complete (command_not_verified)');
    expect(historyContent({ direction: 'in', body: 'try again', meta: {}, tool_receipts: [{ tool: 'x', result: {} }] })).toBe('try again');
  });
});

describe('history is fitted by size and the rest is summarized', () => {
  it('keeps the newest messages within the budget, never fewer than the minimum', () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ direction: (i % 2 ? 'out' : 'in') as 'in' | 'out', body: `m${29 - i} ${'x'.repeat(1000)}`, meta: {} }));
    const { window, older } = fitHistory(rows, 10_000, 4);
    expect(window.length).toBe(9);
    expect(window[window.length - 1].content.startsWith('m29')).toBe(true);
    expect(older.length).toBe(21);
    const huge = fitHistory(rows.map(r => ({ ...r, body: 'y'.repeat(50_000) })), 10_000, 4);
    expect(huge.window.length).toBe(4);
  });

  it('a long conversation keeps its beginning through the running summary', async () => {
    const t = threads.photos;
    for (let i = 0; i < 70; i++) await message(t, i % 2 ? 'out' : 'in', `${i === 0 ? 'My shop is romansgaragesale.com. ' : ''}message ${i} ${'z'.repeat(1500)}`, new Date(Date.UTC(2026, 9, 1, 10, i)).toISOString());
    const inbound = await message(t, 'in', 'keep going', new Date(Date.UTC(2026, 9, 1, 12)).toISOString());
    const before = await conversationHistory(db, { threadId: t, excludeMessageId: inbound, before: null });
    expect(before.needsSummary).toBe(true);
    expect(before.summaryUsed).toBe(false);

    scripted = 'Roman sells on romansgaragesale.com. Early messages covered listing photos.';
    expect((await summarizeThread(db, registry(), t)).updated).toBe(true);
    expect(allUser).toContain('My shop is romansgaragesale.com');
    const after = await conversationHistory(db, { threadId: t, excludeMessageId: inbound, before: null });
    expect(after.summaryUsed).toBe(true);
    expect(after.needsSummary).toBe(false);
    expect(after.history[0].content.startsWith(SUMMARY_LABEL)).toBe(true);
    expect(after.history[0].content).toContain('romansgaragesale.com');
  });
});

describe('recall finds the owner\'s own earlier conversations, and only theirs', () => {
  it('searches other threads of the same owner, never another person\'s', async () => {
    await message(threads.older, 'in', 'The HP Pavilion tower has an i7 and 16 GB of memory', '2026-09-20T10:00:00Z');
    await message(threads.other, 'in', 'My HP Pavilion is broken', '2026-09-21T10:00:00Z');
    const hits = await searchOwnHistory(db, { ownerUserId: ids.roman, query: 'what did I say about the HP Pavilion?', threadId: threads.photos });
    expect(hits.map(h => h.snippet)).toEqual(['The HP Pavilion tower has an i7 and 16 GB of memory']);
    const recall = createRecall(db, { ownerUserId: ids.roman, threadId: threads.photos, windowStart: null });
    expect(await recall.lookup('HP Pavilion specs')).toContain('i7 and 16 GB');
    expect(recall.found).toHaveLength(1);
  });

  it('the recalled snippet reaches the model in a turn', async () => {
    await message(threads.older, 'in', 'The HP Pavilion tower has an i7 and 16 GB of memory', '2026-09-20T10:00:00Z');
    const recall = createRecall(db, { ownerUserId: ids.roman, threadId: threads.photos, windowStart: null });
    await runAssistantTurn({ db, registry: registry(), userId: ids.roman, threadId: threads.photos, history: [], inbound: 'How much memory does the HP Pavilion have?', recall: recall.lookup });
    expect(lastSystem).toContain('From this person\'s own history');
    expect(lastSystem).toContain('16 GB');
  });
});

describe('facts the person states are learned, grounded in their own words', () => {
  it('suggests a quoted fact, discards an ungrounded or sensitive one', async () => {
    scripted = JSON.stringify({ facts: [
      { fact: 'Roman sells used electronics on romansgaragesale.com', quote: 'I sell used electronics on romansgaragesale.com', confidence: 0.8 },
      { fact: 'Roman owns a boat', quote: 'I own a boat', confidence: 0.9 },
      { fact: 'Roman takes medication daily', quote: 'I sell used electronics', confidence: 0.9 },
    ], correction: null });
    const out = await learnFromTurn(db, registry(), { ownerUserId: ids.roman, threadId: threads.photos, turnId: null,
      userMessage: 'I sell used electronics on romansgaragesale.com, help me list these.', previousReply: '', reply: '' });
    expect(out.suggested).toBe(1);
    const rows = await db.query<{ content: string }>('select content from memory_suggestions');
    expect(rows.map(r => r.content)).toEqual(['Roman sells used electronics on romansgaragesale.com']);
  });

  it('saves directly when the person chose automatic memory, and never when memory is off', async () => {
    scripted = JSON.stringify({ facts: [{ fact: 'Roman prefers short replies', quote: 'I prefer short replies', confidence: 0.8 }], correction: null });
    await db.query(`insert into persona_settings(user_id, memory_mode) values($1,'automatic')`, [ids.roman]);
    await learnFromTurn(db, registry(), { ownerUserId: ids.roman, threadId: null, turnId: null, userMessage: 'I prefer short replies from now on', previousReply: '', reply: '' });
    expect((await db.query('select 1 from memories')).length).toBe(1);
    await db.query(`update persona_settings set memory_mode='off' where user_id=$1`, [ids.roman]);
    await db.query('delete from memories');
    await learnFromTurn(db, registry(), { ownerUserId: ids.roman, threadId: null, turnId: null, userMessage: 'I prefer short replies from now on', previousReply: '', reply: '' });
    expect((await db.query('select 1 from memories')).length).toBe(0);
  });

  it('records a correction as an insight', async () => {
    scripted = JSON.stringify({ facts: [], correction: { summary: 'Described a photo that it could not see', quote: 'that is wrong, it is an HP tower' } });
    const out = await learnFromTurn(db, registry(), { ownerUserId: ids.roman, threadId: threads.photos, turnId: null,
      userMessage: 'No, that is wrong, it is an HP tower', previousReply: 'Photo 1 shows a vintage portrait', reply: '' });
    expect(out.insight).toBe(true);
    expect((await db.query<{ kind: string }>('select kind from assistant_insights'))[0].kind).toBe('correction');
  });
});

describe('insights, proposals and the administrator\'s decision', () => {
  it('records real failures and "I can\'t", skips approvals, and does not repeat itself', async () => {
    const args = { ownerUserId: ids.roman, threadId: threads.photos, turnId: null, reply: 'I can\'t see the photos themselves.', actions: [
      { tool: 'browser_view_photo', result: { ok: false, code: 'photo_unavailable' } },
      { tool: 'browser_read_page', result: { ok: false, code: 'awaiting_approval' } },
      { tool: 'browser_read_page', result: { ok: true } },
    ] };
    expect(await recordTurnInsights(db, args)).toBe(2);
    expect(await recordTurnInsights(db, args)).toBe(0);
    const rows = await db.query<{ kind: string; evidence: { repeats?: number } }>('select kind, evidence from assistant_insights order by kind');
    expect(rows.map(r => r.kind)).toEqual(['capability_gap', 'tool_failure']);
    expect(rows[1].evidence.repeats).toBe(2);
  });

  it('accepts only safe, evidence-backed proposals', () => {
    const ins = new Set(['00000000-0000-4000-8000-000000000001']);
    const tools = new Set(toolNames);
    const base = { title: 'Describe listing photos', problem: 'Photos were described wrongly', risk: 'low', insightIds: [...ins] };
    expect(validateProposal({ ...base, kind: 'skill', skill: { name: 'Listing photos', whenToUse: 'describing photos on a listing page', steps: '1. read the page\n2. view each photo', tools: ['browser_read_page', 'browser_view_photo'] } }, tools, ins)?.change.kind).toBe('skill');
    expect(validateProposal({ ...base, kind: 'skill', skill: { name: 'x', whenToUse: 'y', steps: 'z', tools: ['run_shell'] } }, tools, ins)).toBeNull();
    expect(validateProposal({ ...base, insightIds: ['00000000-0000-4000-8000-000000000009'], kind: 'memory_rule', rule: 'Remember model numbers' }, tools, ins)).toBeNull();
    expect(validateProposal({ ...base, kind: 'memory_rule', rule: 'Store the password hunter2 for the shop' }, tools, ins)).toBeNull();
    expect(firstJson('Sure! {"a":{"b":"}"}} trailing')).toEqual({ a: { b: '}' } });
  });

  it('review proposes, only the administrator applies, the skill guides matching turns, and rollback restores', async () => {
    for (const s of ['browser_view_photo did not complete (photo_unavailable)', 'Josi said: "I can\'t see the photos"', 'Described a photo it could not see'])
      await db.query(`insert into assistant_insights(owner_user_id,kind,summary) values($1,'feedback',$2)`, [ids.roman, s]);
    const insightIds = (await db.query<{ id: string }>('select id from assistant_insights')).map(r => r.id);
    scripted = JSON.stringify({ proposals: [{ title: 'Describe listing photos reliably', problem: 'Photos were described without being seen', kind: 'skill', risk: 'low',
      skill: { key: 'listing-photos', name: 'Listing photos', whenToUse: 'describing photos on a listing or upload page', steps: '1. Read the page.\n2. View each photo with browser_view_photo.\n3. Describe only what is visible.', tools: ['browser_read_page', 'browser_view_photo'] },
      insightIds }] });
    expect((await reviewInsights(db, registry(), toolNames)).proposed).toBe(1);
    const [proposal] = await db.query<{ id: string }>('select id from improvement_proposals');

    expect(await announceProposals(db, ids.guest)).toBe('');
    expect(await announceProposals(db, ids.roman)).toContain('Describe listing photos reliably');
    expect(await announceProposals(db, ids.roman)).toBe('');

    await expect(decideProposal(db, { adminId: ids.guest, proposalId: proposal.id, approve: true, toolNames })).rejects.toThrow(/administrator/);
    expect((await loadGuidance(db, 'please describe the listing photos')).skills).toHaveLength(0);
    await decideProposal(db, { adminId: ids.roman, proposalId: proposal.id, approve: true, toolNames });
    const guided = await loadGuidance(db, 'please describe the listing photos');
    expect(guided.skills.map(s => s.version)).toEqual([1]);
    expect(guided.text).toContain('never override the safety rules');
    expect((await loadGuidance(db, 'what is the weather')).skills).toHaveLength(0);

    // A second version, then rollback to the first.
    const [second] = await db.query<{ id: string }>(`insert into improvement_proposals(title,problem,change_kind,change,evidence) values('v2','better','skill',$1,$2) returning id`,
      [JSON.stringify({ kind: 'skill', skill: { key: 'listing-photos', name: 'Listing photos', whenToUse: 'describing listing photos', steps: 'v2 steps', tools: [] } }), JSON.stringify(insightIds.slice(0, 1))]);
    await decideProposal(db, { adminId: ids.roman, proposalId: second.id, approve: true, toolNames });
    expect((await loadGuidance(db, 'describe the listing photos')).skills[0].version).toBe(2);
    expect((await rollbackSkill(db, { adminId: ids.roman, skillKey: 'listing-photos' })).restoredVersion).toBe(1);
    expect((await loadGuidance(db, 'describe the listing photos')).skills[0].version).toBe(1);
  });

  it('an approved memory rule reaches every turn, below the safety rules', async () => {
    await db.query(`insert into memory_rules(rule) values('Remember the model number of every item Roman lists')`);
    await runAssistantTurn({ db, registry: registry(), userId: ids.roman, threadId: threads.photos, history: [], inbound: 'hello' });
    expect(lastSystem).toContain('Remember the model number of every item Roman lists');
    expect(lastSystem.indexOf('Remember the model number')).toBeGreaterThan(lastSystem.indexOf('never'));
  });
});
