// Josi opens a card for you to sign in for her (docs/LIVE_SIGN_IN.md).
//
// She never types a password, token or code. When she needs a login she cannot
// do (a website in her own browser, or a command such as `gh auth login`), the
// server builds a sign-in card from the tool's few plain fields and records it
// as a settings-change proposal with area `sign_in_card`. The person presses
// Open in the app and signs in themselves on a live view of her browser or in
// a terminal. The model gets back only "card opened" and, later, the note that
// says the person finished or closed it. It never receives the screen, a key
// or terminal output.
import { json, mayLiveSignIn, readLocalExecutors, type Db } from '@josi-ce/core';
import type { ToolSpec } from './tools.js';

export const SIGN_IN_CARD_AREA = 'sign_in_card';

export const SIGN_IN_TOOLS: ToolSpec[] = [
  { def: { name: 'request_sign_in',
    description: 'Open a card in the Josi app for the person to sign in for you, when you need a login you cannot do yourself: mode "browser" opens a live view of YOUR browser on this computer (optionally at a website\'s sign-in page) where they sign in to a site; mode "terminal" opens a terminal that runs exactly the command you give (for example "gh auth login", "aws sso login", "docker login") where they finish a computer-wide sign-in. You never see the screen, what they type or the terminal output, and you never ask for passwords, codes or tokens in chat. Use it instead of telling them to sign in somewhere they cannot see. Say the card is open and stop; a note appears here when they finish or close it, then check it worked with your ordinary tools (for example pc_run_command with "gh auth status", or browser_open_page).',
    parameters: { type: 'object', properties: {
      mode: { type: 'string', enum: ['browser', 'terminal'], description: 'browser: a site in your own browser. terminal: a command that signs this computer in to something.' },
      title: { type: 'string', maxLength: 80, description: 'What they are signing in to, in plain words, for example "GitHub" or "Amazon Web Services".' },
      why: { type: 'string', maxLength: 300, description: 'One or two plain sentences: what you need it for.' },
      url: { type: 'string', maxLength: 2048, description: 'Browser mode: the exact https address of the sign-in page to open first. Optional.' },
      command: { type: 'string', maxLength: 200, description: 'Terminal mode, required: the one command line to run, exactly as it should run. It is shown on the card before they press Open.' },
    }, required: ['mode', 'title', 'why'], additionalProperties: false } }, actionClass: null },
];
export const SIGN_IN_TOOL_NAMES = new Set(SIGN_IN_TOOLS.map((t) => t.def.name));

export const SIGN_IN_PROMPT = 'When you need the person to sign in somewhere for you (a website, or a computer-wide login like a command line tool), call request_sign_in: a card opens for them, they sign in themselves, and you never see the screen, the keys or the terminal output. Never ask for a password, code or token in chat. After the note says they finished, verify with ordinary tools before you carry on.';

/** A computer running Josi's own PC service for Linux that is connected and switched on. */
async function signInPc(db: Db): Promise<string | null> {
  const [row] = await db.query<{ pc_id: string }>(
    `select s.pc_id from pc_control_settings s join pc_control_presence p on p.owner_user_id = s.owner_user_id and p.pc_id = s.pc_id
     where s.enabled and p.expires_at > now() and s.pc_id like 'linux-%' order by p.expires_at desc limit 1`);
  return row?.pc_id ?? null;
}

/** Offered only where it can work: a person allowed to sign in, and a connected Linux server with PC control on. */
export async function signInToolAvailability(db: Db, userId: string): Promise<ToolSpec[]> {
  try {
    const [user] = await db.query<{ id: string; role: string }>('select id, role from users where id = $1', [userId]);
    if (!user || !await mayLiveSignIn(db, user)) return [];
    return await signInPc(db) ? SIGN_IN_TOOLS : [];
  } catch { return []; }
}

const plain = (value: unknown, max: number) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

export async function executeSignInTool(db: Db, userId: string, name: string, input: Record<string, unknown>, threadId: string | null) {
  if (name !== 'request_sign_in') return { ok: false, code: 'unknown_tool' };
  const [user] = await db.query<{ id: string; role: string }>('select id, role from users where id = $1', [userId]);
  if (!user || !await mayLiveSignIn(db, user))
    return { ok: false, code: 'not_allowed', message: 'Only the owner, or someone the owner allowed, can sign in for you. Tell the person, and offer to ask the owner to allow it.' };
  const pcId = await signInPc(db);
  if (!pcId) return { ok: false, code: 'no_computer', message: 'Your computer is not connected with PC control on, so a sign-in view cannot open. Tell the person to turn PC control on (you can prepare that), then try again.' };

  const mode = input.mode === 'terminal' ? 'terminal' : input.mode === 'browser' ? 'browser' : null;
  if (!mode) return { ok: false, code: 'bad_mode', message: 'Choose mode "browser" or "terminal".' };
  const title = plain(input.title, 80) || (mode === 'browser' ? 'Sign in' : 'Sign in on this computer');
  const why = plain(input.why, 300);
  if (!why) return { ok: false, code: 'needs_reason', message: 'Say in a sentence why you need the sign-in.' };
  let url: string | null = null, command: string | null = null;
  if (mode === 'browser' && typeof input.url === 'string' && input.url.trim()) {
    try {
      const parsed = new URL(input.url.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new Error('bad');
      url = parsed.toString();
    } catch { return { ok: false, code: 'bad_url', message: 'Use one exact https:// address without a username or password, or leave the address out.' }; }
  }
  if (mode === 'terminal') {
    const raw = typeof input.command === 'string' ? input.command.trim() : '';
    if (!raw || raw.length > 200 || /[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, code: 'bad_command', message: 'Give the one-line command to run, up to 200 characters, with no line breaks.' };
    command = raw;
  }
  const runAs = readLocalExecutors().find((h) => h.pcId === pcId)?.user ?? null;
  const card = {
    kind: 'sign_in', mode, pcId, title, intro: why, url, command, runAs,
    done: mode === 'browser' ? `Thanks. The sign-in stays in Josi's browser until you clear it.` : `Thanks. I will check it worked.`,
  };
  // One open card per conversation at a time: an earlier unopened one is superseded.
  await db.query(`update settings_change_proposals set state = 'expired' where proposer_user_id = $1 and area = $2 and state = 'proposed'
    and (thread_id is not distinct from $3)`, [userId, SIGN_IN_CARD_AREA, threadId]);
  const [row] = await db.query<{ id: string }>(
    `insert into settings_change_proposals(proposer_user_id, scope, area, sensitive, title, summary, method, path, body, thread_id)
     values ($1, 'personal', $2, false, $3, $4, 'POST', '/live-signin/sessions', $5, $6) returning id`,
    [userId, SIGN_IN_CARD_AREA, title, why, json({ card, fixed: {} }), threadId]);
  return { ok: true, cardId: row.id, state: 'card_open',
    message: `A sign-in card titled "${title}" is open in the Josi app${mode === 'terminal' ? ` (it will run: ${command})` : ''}. Say it is open and wait; a note here says when they finish or close it. You never see their screen, keys or the output. Then check it worked with your ordinary tools.` };
}
