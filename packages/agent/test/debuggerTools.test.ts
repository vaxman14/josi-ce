// The debugger's tools: who gets them, and reading her own source read-only.
import { beforeEach, describe, expect, it } from 'vitest';
import { testDb, testVault, type TestDb } from '../../core/test/helpers.js';
import { createUser } from '../../auth/src/users.js';
import { addMessage, createThread, MasterKey } from '@josi-ce/core';
import { saveDeveloperConnection } from '@josi-ce/connectors';
import { DEBUGGER_PROMPT, DEBUGGER_TOOLS, debuggerToolAvailability, executeDebuggerTool, sourceLocation } from '../src/debuggerTools.js';
import { ALL_TOOLS } from '../src/tools.js';

let db: TestDb; let owner: string; let member: string; let thread: string;
const key = new MasterKey(Buffer.alloc(32, 9));
beforeEach(async () => {
  delete process.env.JOSI_DEBUGGER;
  db = await testDb();
  owner = (await createUser(db, { email: 'owner@example.test', username: 'owner', role: 'super_admin' })).id;
  member = (await createUser(db, { email: 'member@example.test', username: 'member', role: 'member' })).id;
  await testVault(db, key);
  thread = (await createThread(db, { ownerUserId: owner })).id;
});

const asked: string[] = [];
const github = (async (url: RequestInfo | URL, init?: RequestInit) => {
  const address = String(url); asked.push(address);
  expect((init?.headers as Record<string, string>).authorization).toBe('Bearer synthetic-token');
  if (address.includes('/git/trees/')) return new Response(JSON.stringify({ tree: [
    { path: 'packages/core/src/actionState.ts', type: 'blob' }, { path: 'packages/core/src/workGoals.ts', type: 'blob' },
    { path: 'packages/core/dist/actionState.js', type: 'blob' }, { path: 'node_modules/x/actionState.js', type: 'blob' }, { path: 'packages/core/src', type: 'tree' },
  ] }), { status: 200 });
  if (address.includes('/contents/packages/core/src/actionState.ts')) return new Response(['line one', 'const YES=/yes/;', 'line three', 'line four', 'export function prepareActionAgain(){}', 'last'].join('\n'), { status: 200 });
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const run = (name: string, input: Record<string, unknown>, who = owner) => executeDebuggerTool(db, who, thread, key, name, input, github) as Promise<any>;

describe('who has the debugger', () => {
  it('is the owner\'s alone, and gone when the switch is off', async () => {
    expect((await debuggerToolAvailability(db, owner, thread)).map((t) => t.def.name)).toEqual(DEBUGGER_TOOLS.map((t) => t.def.name));
    expect(await debuggerToolAvailability(db, member, thread)).toEqual([]);
    expect(await debuggerToolAvailability(db, owner, null)).toEqual([]);
    expect(await run('debug_investigate', {}, member)).toMatchObject({ ok: false, code: 'not_available' });
    process.env.JOSI_DEBUGGER = '0';
    expect(await debuggerToolAvailability(db, owner, thread)).toEqual([]);
    expect(await run('debug_investigate', {})).toMatchObject({ ok: false, code: 'not_available' });
  });

  it('is in the registry, and says what she must not do', () => {
    for (const tool of DEBUGGER_TOOLS) expect(ALL_TOOLS.some((t) => t.def.name === tool.def.name), tool.def.name).toBe(true);
    expect(DEBUGGER_PROMPT).toMatch(/cannot change the program that is running/);
    expect(DEBUGGER_PROMPT).toMatch(/only after they say yes in a later message/);
    expect(DEBUGGER_PROMPT).toMatch(/handoff for Claude/);
  });
});

describe('investigating and repairing through the tools', () => {
  it('returns the case file, and refuses a repair the person has not answered', async () => {
    await addMessage(db, { threadId: thread, direction: 'in', body: 'why did that not work?' });
    const file = await run('debug_investigate', { minutes: 60 });
    expect(file).toMatchObject({ ok: true, findings: [], window: { minutes: 60 } });
    const proposed = await run('debug_propose_repair', { kind: 'run_reconcile' });
    expect(proposed.ok).toBe(true);
    expect(await run('debug_run_repair', { repair_id: proposed.repair_id })).toMatchObject({ ok: false, code: 'repair_refused' });
    await addMessage(db, { threadId: thread, direction: 'in', body: 'yes' });
    expect(await run('debug_run_repair', { repair_id: proposed.repair_id })).toMatchObject({ ok: true, repaired: 'run_reconcile' });
    expect(await run('debug_propose_repair', { kind: 'rewrite_everything' })).toMatchObject({ ok: false, code: 'repair_refused' });
  });
});

describe('her own source', () => {
  it('says how to get it when no repository is connected', async () => {
    expect(await run('debug_find_source', { contains: 'actionState' })).toMatchObject({ ok: false, code: 'no_repository' });
  });

  it('finds and reads files, read-only, leaving out built and vendored code', async () => {
    await saveDeveloperConnection(db, key, { ownerUserId: owner, service: 'github', credentials: { token: 'synthetic-token' }, accountLabel: 'Fixture' });
    asked.length = 0;
    const found = await run('debug_find_source', { contains: 'actionstate' });
    expect(found).toMatchObject({ ok: true, repository: 'vaxman14/josi-ce', ref: sourceLocation().ref, paths: ['packages/core/src/actionState.ts'] });
    const read = await run('debug_read_source', { path: 'packages/core/src/actionState.ts', start_line: 2, end_line: 3 });
    expect(read.lines).toEqual(['2: const YES=/yes/;', '3: line three']);
    const grep = await run('debug_read_source', { path: 'packages/core/src/actionState.ts', grep: 'prepareActionAgain' });
    expect(grep.matches).toBe(1);
    expect(grep.lines).toContain('5: export function prepareActionAgain(){}');
    expect(asked.every((url) => url.startsWith('https://api.github.com/repos/vaxman14/josi-ce/'))).toBe(true);
    for (const path of ['../etc/passwd', '/etc/passwd', 'node_modules/x/index.js', 'packages/core/dist/a.js', 'logo.png'])
      expect(await run('debug_read_source', { path }), path).toMatchObject({ ok: false, code: 'bad_path' });
    expect(await run('debug_read_source', { path: 'packages/core/src/missing.ts' })).toMatchObject({ ok: false, code: 'no_such_file' });
  });

  it('knows where each edition\'s source lives, and takes an override', () => {
    expect(sourceLocation({}, 'linux')).toEqual({ repo: 'vaxman14/josi-ce', ref: 'linux/josi-server' });
    expect(sourceLocation({}, 'win32').ref).toBe('redesign/windows-lean-beta');
    expect(sourceLocation({ JOSI_SOURCE_REPO: 'someone/fork', JOSI_SOURCE_REF: 'v1.3.0' }, 'linux')).toEqual({ repo: 'someone/fork', ref: 'v1.3.0' });
    expect(sourceLocation({ JOSI_SOURCE_REPO: 'https://evil.example/x', JOSI_SOURCE_REF: 'a b;rm' }, 'linux')).toEqual({ repo: 'vaxman14/josi-ce', ref: 'linux/josi-server' });
  });
});

describe('the handoff', () => {
  it('is filed with its case, and given in chat when no device can take it', async () => {
    const text = `# Expired approval\n\n${'What happened, why, where, and what a fix must do. '.repeat(8)}`;
    expect(await run('debug_write_handoff', { title: 'Expired approval', markdown: text })).toMatchObject({ ok: false, code: 'investigate_first' });
    await run('debug_investigate', {});
    expect(await run('debug_write_handoff', { title: 'Expired approval', markdown: 'too short' })).toMatchObject({ ok: false, code: 'too_short' });
    const filed = await run('debug_write_handoff', { title: 'Expired approval', markdown: text });
    expect(filed).toMatchObject({ ok: true, filed: true, sent: false });
    expect(filed.file).toMatch(/^josi-handoff-\d{4}-\d{2}-\d{2}-expired-approval\.md$/);
    expect((await db.query<{ handoff: string }>('select handoff from debug_cases where handoff is not null'))[0].handoff).toBe(text);
  });
});
