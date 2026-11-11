// Josi's built-in debugger, as the owner meets it in chat.
// Plan: docs/JOSI_DEBUGGER_PLAN.md. The records and repairs are in
// packages/core/src/debugger.ts; this file is the tools and what she is told.
//
// Owner only, and only while the debugger switch is on. She investigates when
// asked, repairs her own records from a fixed list after a yes, and for a
// fault in her program she stops and offers a stronger model or a handoff. She
// reads her own source through the repository the owner connected (GitHub,
// read-only); she never changes the program that is running.
import { collectDebugCase, DebugRepairError, debuggerEnabled, proposeDebugRepair, runDebugRepair, saveDebugHandoff, type Db, type MasterKey } from '@josi-ce/core';
import { loadDeveloperCredentials } from '@josi-ce/connectors';
import type { ToolSpec } from './tools.js';
import { executeSendFileTool, plainFileName } from './sendFileTools.js';

export const DEBUGGER_TOOLS: ToolSpec[] = [
  { def: { name: 'debug_investigate',
    description: 'Look into what went wrong in THIS conversation. Returns the case file from your own records: what was said, which tools ran and what they returned, approval requests and whether they expired, tasks, the goal and its open question, the audit trail, background jobs, connected accounts, and the patterns recognised in them (findings), each with a repair where one exists. Read-only. Call it whenever the owner asks what happened, why something did not work, or to debug something; never answer such a question from memory.',
    parameters: { type: 'object', properties: {
      minutes: { type: 'integer', minimum: 15, maximum: 1440, description: 'How far back to look. Default 180.' },
    }, additionalProperties: false } }, actionClass: null },
  { def: { name: 'debug_propose_repair',
    description: 'Propose one repair from the fixed list, for a finding of debug_investigate. It changes nothing yet: it records the proposal and returns what the repair will do, in words to tell the owner. Then stop and ask them.',
    parameters: { type: 'object', properties: {
      kind: { type: 'string', enum: ['prepare_request_again', 'goal_continue', 'run_reconcile'] },
      target_id: { type: 'string', maxLength: 40, description: 'The id from the finding\'s repair (a request or goal id). Not needed for run_reconcile.' },
    }, required: ['kind'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'debug_run_repair',
    description: 'Carry out a repair you proposed earlier, after the owner said yes in a later message. Refused if they have not answered since it was proposed.',
    parameters: { type: 'object', properties: {
      repair_id: { type: 'string', maxLength: 40 },
    }, required: ['repair_id'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'debug_find_source',
    description: 'Find files in your own source code by part of their path or name (for example "actionState" or "workGoals"). Returns matching paths. Read-only, from the repository the owner connected.',
    parameters: { type: 'object', properties: {
      contains: { type: 'string', minLength: 2, maxLength: 80 },
    }, required: ['contains'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'debug_read_source',
    description: 'Read one file of your own source code, or only its lines that contain a word. Returns numbered lines. Read-only.',
    parameters: { type: 'object', properties: {
      path: { type: 'string', maxLength: 300, description: 'A path returned by debug_find_source.' },
      start_line: { type: 'integer', minimum: 1 },
      end_line: { type: 'integer', minimum: 1 },
      grep: { type: 'string', maxLength: 80, description: 'Return only lines containing this text (with two lines around each).' },
    }, required: ['path'], additionalProperties: false } }, actionClass: null },
  { def: { name: 'debug_write_handoff',
    description: 'File the handoff you wrote for a coding assistant (Claude) and send it to the owner\'s device as a Markdown file. Only when the owner asked for a handoff.',
    parameters: { type: 'object', properties: {
      title: { type: 'string', maxLength: 120 },
      markdown: { type: 'string', maxLength: 200000, description: 'The whole handoff.' },
    }, required: ['title', 'markdown'], additionalProperties: false } }, actionClass: null },
];
export const DEBUGGER_TOOL_NAMES = new Set(DEBUGGER_TOOLS.map((t) => t.def.name));

export const DEBUGGER_PROMPT = [
  'You have a built-in debugger, for the owner only. When they ask what went wrong, why something did not happen, or to debug something, call debug_investigate first and answer from its case file, never from memory.',
  'Answer with one report in plain words, under these headings and no others: "What happened" (a short timeline, times in their own timezone), "Why" (the cause and how sure you are), "What I can do now", "What needs you", and, only when the cause is a fault in your own program, "What needs a code change". Finish with a short "Details" list of the evidence you used. Drop a heading that has nothing under it. If the records do not show the cause, say so and say what would.',
  'Name the cause as exactly one of: something stuck or expired in your records; a setting; something outside you (a provider, the network); your own wrong answer; a fault in your program.',
  'Repairs: you may only make the repairs a finding offers. Call debug_propose_repair, tell the owner what it will do in its own words, and ask. Call debug_run_repair only after they say yes in a later message. A repair never sends, deletes or spends by itself; anything like that still goes through its approval card.',
  'A fault in your program is not yours to fix in place: you cannot change the program that is running, and you must not try. Say plainly that it needs a code change and offer two things: to look deeper with a stronger coding model (they can ask you to switch models), or to write a handoff for Claude.',
  'For a handoff, find the code first with debug_find_source and debug_read_source, then write it: what the owner asked, the timeline, the evidence, the cause, where the fault is (file, function, lines), an example to turn into a failing test, and what a fix must do from the person\'s side. Then call debug_write_handoff. Never put a credential, a token or the full text of someone\'s email in it.',
].join(' ');

/** Offered to the owner while the switch is on. */
export async function debuggerToolAvailability(db: Db, userId: string, threadId: string | null): Promise<ToolSpec[]> {
  if (!debuggerEnabled() || !threadId) return [];
  try {
    const [user] = await db.query<{ role: string }>(`select role from users where id = $1 and status = 'active'`, [userId]);
    return user?.role === 'super_admin' ? DEBUGGER_TOOLS : [];
  } catch { return []; }
}

// ------------------------------------------------------------- her own source

/** Which repository holds her source, and which branch this build came from.
 * JOSI_SOURCE_REPO and JOSI_SOURCE_REF override; otherwise the public home of
 * the code and the branch of this platform's edition. */
export function sourceLocation(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): { repo: string; ref: string } {
  const repo = /^[\w.-]+\/[\w.-]+$/.test(env.JOSI_SOURCE_REPO ?? '') ? env.JOSI_SOURCE_REPO! : 'vaxman14/josi-ce';
  const fallback = platform === 'win32' ? 'redesign/windows-lean-beta' : platform === 'darwin' ? 'redesign/mac-lean-beta' : 'linux/josi-server';
  const ref = /^[\w./-]{1,120}$/.test(env.JOSI_SOURCE_REF ?? '') ? env.JOSI_SOURCE_REF! : fallback;
  return { repo, ref };
}

const SOURCE_PATH = /^(?!\/)(?!.*\.\.)[\w@./ -]{1,300}$/;
const NOT_SOURCE = /(^|\/)(node_modules|dist|\.git)\/|\.(png|jpe?g|gif|webp|ico|woff2?|ttf|mp4|mov|zip|gz|zst|pdf|lock)$/i;
const MAX_LINES = 220;

async function github(token: string, path: string, fetchImpl: typeof fetch, raw = false): Promise<Response> {
  return fetchImpl(`https://api.github.com${path}`, {
    headers: { authorization: `Bearer ${token}`, accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28', 'user-agent': 'josi-debugger' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
}

async function sourceToken(db: Db, key: MasterKey | null, userId: string): Promise<string | { ok: false; code: string; message: string }> {
  if (!key) return { ok: false, code: 'vault_locked', message: 'The Vault is locked, so the repository cannot be read right now.' };
  try {
    const token = (await loadDeveloperCredentials(db, key, { ownerUserId: userId, service: 'github' })).credentials.token;
    if (!token) throw new Error('no token');
    return token;
  } catch {
    return { ok: false, code: 'no_repository', message: 'No GitHub account is connected, so you cannot read your own source. You can still investigate and repair. Tell the owner that connecting GitHub (Connections, developer services) lets you name the file and lines in a handoff.' };
  }
}

export async function executeDebuggerTool(db: Db, userId: string, threadId: string | null, key: MasterKey | null, name: string,
  input: Record<string, unknown>, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  if (!DEBUGGER_TOOL_NAMES.has(name)) return { ok: false, code: 'unknown_tool' };
  if (!(await debuggerToolAvailability(db, userId, threadId)).length || !threadId) return { ok: false, code: 'not_available', message: 'The debugger is not available here.' };
  try {
    if (name === 'debug_investigate') {
      const file = await collectDebugCase(db, { ownerUserId: userId, threadId, minutes: typeof input.minutes === 'number' ? input.minutes : undefined });
      return { ok: true, ...file };
    }
    if (name === 'debug_propose_repair') {
      const proposed = await proposeDebugRepair(db, { ownerUserId: userId, threadId, kind: String(input.kind ?? ''), targetId: typeof input.target_id === 'string' ? input.target_id : null });
      return { ok: true, ...proposed, message: 'Nothing has changed yet. Tell the owner what this will do and ask. Run it only after their yes, in a later message.' };
    }
    if (name === 'debug_run_repair') return await runDebugRepair(db, { ownerUserId: userId, threadId, repairId: String(input.repair_id ?? '') });

    if (name === 'debug_write_handoff') {
      const title = String(input.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Josi handoff';
      const markdown = String(input.markdown ?? '');
      if (markdown.trim().length < 200) return { ok: false, code: 'too_short', message: 'That is not a handoff yet. Write the whole thing: what was asked, the timeline, the evidence, the cause, where the fault is, a failing example, and what a fix must do.' };
      const filed = await saveDebugHandoff(db, { ownerUserId: userId, threadId, title, markdown });
      if (!filed) return { ok: false, code: 'investigate_first', message: 'Investigate first: a handoff is filed with its case.' };
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'handoff';
      const file = plainFileName(`josi-handoff-${new Date().toISOString().slice(0, 10)}-${slug}.md`);
      const sent = await executeSendFileTool(db, userId, 'send_file_to_my_devices', { name: file, text: markdown }) as { ok?: boolean; code?: string; to?: unknown; devices?: unknown };
      if (sent.ok) return { ok: true, filed: true, file, sent_to: sent.to, message: `The handoff is filed and "${file}" is on its way to that device. Do not say it has arrived.` };
      return { ok: true, filed: true, file, sent: false, devices: sent.devices,
        message: sent.code === 'no_devices' ? 'The handoff is filed, but the owner has no device signed in to receive files. Give it to them here in the chat instead.'
          : 'The handoff is filed. Ask the owner which device to send it to, then send it with send_file_to_my_devices, or give it to them here.' };
    }

    // Her own source, read-only, through the owner's GitHub connection.
    const token = await sourceToken(db, key, userId);
    if (typeof token !== 'string') return token;
    const { repo, ref } = sourceLocation();
    if (name === 'debug_find_source') {
      const wanted = String(input.contains ?? '').trim().toLowerCase();
      if (wanted.length < 2) return { ok: false, code: 'too_short', message: 'Give at least two letters of the path.' };
      const res = await github(token, `/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`, fetchImpl);
      if (!res.ok) return { ok: false, code: 'repository_unreadable', status: res.status, message: `The repository ${repo} (${ref}) could not be read with the connected GitHub account.` };
      const tree = await res.json() as { tree?: Array<{ path?: string; type?: string }> };
      const paths = (tree.tree ?? []).filter((e) => e.type === 'blob' && typeof e.path === 'string' && !NOT_SOURCE.test(e.path!) && e.path!.toLowerCase().includes(wanted)).map((e) => e.path!);
      return { ok: true, repository: repo, ref, matches: paths.length, paths: paths.slice(0, 40), more: paths.length > 40 };
    }
    // debug_read_source
    const path = String(input.path ?? '').trim();
    if (!SOURCE_PATH.test(path) || NOT_SOURCE.test(path)) return { ok: false, code: 'bad_path', message: 'Use a path that debug_find_source returned.' };
    const res = await github(token, `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, fetchImpl, true);
    if (!res.ok) return { ok: false, code: res.status === 404 ? 'no_such_file' : 'repository_unreadable', status: res.status, message: `${path} could not be read from ${repo} (${ref}).` };
    const lines = (await res.text()).split('\n');
    const numbered = (from: number, to: number) => lines.slice(from - 1, to).map((text, i) => `${from + i}: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
    const grep = typeof input.grep === 'string' ? input.grep.trim() : '';
    if (grep) {
      const hits: number[] = [];
      lines.forEach((text, i) => { if (text.toLowerCase().includes(grep.toLowerCase())) hits.push(i + 1); });
      const out: string[] = [];
      for (const hit of hits.slice(0, 30)) { out.push(...numbered(Math.max(1, hit - 2), Math.min(lines.length, hit + 2)), '--'); }
      return { ok: true, repository: repo, ref, path, total_lines: lines.length, matches: hits.length, lines: out.slice(0, MAX_LINES) };
    }
    const start = Math.max(1, Math.trunc(Number(input.start_line) || 1));
    const end = Math.min(lines.length, Math.max(start, Math.trunc(Number(input.end_line) || start + MAX_LINES - 1)), start + MAX_LINES - 1);
    return { ok: true, repository: repo, ref, path, total_lines: lines.length, from: start, to: end, lines: numbered(start, end) };
  } catch (error) {
    if (error instanceof DebugRepairError) return { ok: false, code: 'repair_refused', message: error.message };
    return { ok: false, code: 'debugger_failed', message: 'The debugger could not finish that. Say so, and what you were looking at.' };
  }
}
