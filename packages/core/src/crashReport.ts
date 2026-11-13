// Crash reports and feedback for beta testers.
//
// What goes out is a small, fixed set of facts about the machine and the
// failure, with everything private stripped by `scrub`: no chat content (a
// report never includes any), no Vault data, no email addresses, no sign-in or
// OAuth tokens, no home-folder paths (they become "~"), no IP addresses. The
// owner either lets reports go out by themselves or reads each one first and
// edits or refuses it. The only thing that identifies a tester is the token
// they were given (JOSI_TESTER_TOKEN, or /etc/josi/tester.json), and the only
// place a report goes is the report address.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import { json } from './db.js';
import { resolveDataPath } from './dataPath.js';

export const REPORT_URL_DEFAULT = 'https://heyjosi.com/api/report';
export const REPORT_MAX_BYTES = 256 * 1024;
export const MAX_LOG_LINES = 200;
const MAX_ERROR = 4000, MAX_STACK = 20_000, MAX_LINE = 500, MAX_NOTE = 4000;

// ---------------------------------------------------------------- scrubbing

const PATTERNS: Array<[RegExp, string]> = [
  // Sign-in and API material first, so nothing below tears a token in half.
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [removed]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g, '[token removed]'],
  [/\b(?:sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|AKIA|ya29|1\/\/)[-_A-Za-z0-9.]{12,}/g, '[token removed]'],
  [/\bv1\.[A-Za-z0-9+/=]{8,}\.[A-Za-z0-9+/=._-]{8,}/g, '[sealed value removed]'],
  [/([?&#;](?:token|access_token|refresh_token|id_token|code|key|api_key|apikey|secret|password|passwd|auth|authorization|session|sid|state|handoff)=)[^&\s"'<>]+/gi, '$1[removed]'],
  [/("?(?:password|passwd|secret|token|api_?key|authorization|cookie)"?\s*[:=]\s*)"?[^\s",;}]{3,}"?/gi, '$1[removed]'],
  // People and places.
  [/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[email removed]'],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip removed]'],
  [/\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{1,4}\b/gi, '[ip removed]'],
  [/\b[A-Za-z0-9+/_-]{40,}={0,2}/g, '[removed]'],
  // The home folder of whoever runs this, for any user.
  [/\/home\/[^/\s"'`:;)]+/g, '~'],
  [/\/Users\/[^/\s"'`:;)]+/g, '~'],
  [/[A-Za-z]:\\Users\\[^\\\s"'`:;)]+/gi, '~'],
  [/\/root(?=\/|\b)/g, '~'],
];

/** Everything that could name a person, a place or a credential, taken out. */
export function scrub(text: unknown): string {
  let out = String(text ?? '');
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: unknown, max: number) => clip(scrub(text).replace(/[\r\n]+/g, ' ').trim(), max);

// ---------------------------------------------------------------- the report

export type ReportType = 'crash' | 'feedback';
export interface CrashReport {
  type: ReportType;
  app_version: string;
  model_version: string;
  os: string;
  arch: string;
  cpu: string;
  gpu: string;
  vram: string;
  ram: string;
  docker_version: string;
  uptime: number;
  error: string;
  stack_trace: string;
  last_log_lines: string[];
  user_note: string;
}

const FIELDS_TEXT = ['app_version', 'model_version', 'os', 'arch', 'cpu', 'gpu', 'vram', 'ram', 'docker_version'] as const;

/** A report as it may be sent, whatever it was built from or edited into: only the known fields, every text scrubbed and cut. */
export function scrubReport(input: Partial<Record<keyof CrashReport, unknown>>): CrashReport {
  const text = (value: unknown, max: number) => oneLine(value, max);
  const lines = Array.isArray(input.last_log_lines) ? input.last_log_lines : typeof input.last_log_lines === 'string' ? String(input.last_log_lines).split('\n') : [];
  const report = {
    type: input.type === 'feedback' ? 'feedback' : 'crash',
    uptime: Number.isFinite(Number(input.uptime)) ? Math.max(0, Math.floor(Number(input.uptime))) : 0,
    error: clip(scrub(input.error).trim(), MAX_ERROR),
    stack_trace: clip(scrub(input.stack_trace).trim(), MAX_STACK),
    last_log_lines: lines.slice(-MAX_LOG_LINES).map(line => oneLine(line, MAX_LINE)),
    user_note: clip(scrub(input.user_note).trim(), MAX_NOTE),
  } as CrashReport;
  for (const field of FIELDS_TEXT) (report as unknown as Record<string, string>)[field] = text(input[field], 120);
  return report;
}

// ---------------------------------------------------------------- the log buffer

const recent: string[] = [];
let capturing = false;

/** Keeps the last lines this process wrote to its console (scrubbed) for a report. Safe to call twice. */
export function captureLogs(): void {
  if (capturing) return;
  capturing = true;
  for (const method of ['log', 'info', 'warn', 'error'] as const) {
    const original = console[method].bind(console);
    console[method] = (...parts: unknown[]) => {
      try {
        const line = parts.map(part => (typeof part === 'string' ? part : part instanceof Error ? part.message : JSON.stringify(part))).join(' ');
        recent.push(`${new Date().toISOString().slice(11, 19)} ${oneLine(line, MAX_LINE)}`);
        if (recent.length > MAX_LOG_LINES) recent.splice(0, recent.length - MAX_LOG_LINES);
      } catch { /* a log line must never break logging */ }
      original(...parts);
    };
  }
}
export const recentLogLines = (): string[] => [...recent];

// ---------------------------------------------------------------- facts about this machine

function once<T>(compute: () => T): () => T { let done = false, value: T; return () => { if (!done) { value = compute(); done = true; } return value; }; }

const osName = once(() => {
  try {
    const text = readFileSync('/etc/os-release', 'utf8');
    return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)?.[1] ?? `${platform()} ${release()}`;
  } catch { return `${platform()} ${release()}`; }
});

function nvidia(): Promise<{ gpu: string; vram: string }> {
  return new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], { timeout: 2000 }, (error, stdout) => {
      const first = !error && stdout ? stdout.split('\n')[0]?.split(',').map(part => part.trim()) : null;
      resolve(first && first[0] ? { gpu: first[0], vram: first[1] ?? '' } : { gpu: '', vram: '' });
    });
  });
}

export function appVersion(): string {
  if (process.env.JOSI_APP_VERSION) return process.env.JOSI_APP_VERSION;
  for (const file of ['/var/lib/josi/status.json', join(resolveDataPath('/data'), '..', 'status.json')]) {
    try { const version = JSON.parse(readFileSync(file, 'utf8')).version; if (typeof version === 'string') return version; } catch { /* next */ }
  }
  return 'unknown';
}

/** What a report says about this machine. Nothing here is about a person. */
export async function machineFacts(db?: Db): Promise<Omit<CrashReport, 'type' | 'error' | 'stack_trace' | 'last_log_lines' | 'user_note'>> {
  let model = process.env.JOSI_MODEL_VERSION ?? '';
  if (!model && db) {
    try { const [row] = await db.query<{ provider: string; model: string }>(`select provider, model from llm_providers where role = 'primary'`); if (row) model = `${row.provider}:${row.model}`; } catch { /* unknown */ }
  }
  const gpuFacts = process.env.JOSI_GPU ? { gpu: process.env.JOSI_GPU, vram: process.env.JOSI_VRAM ?? '' } : await nvidia();
  return {
    app_version: appVersion(), model_version: model, os: osName(), arch: arch(), cpu: cpus()[0]?.model ?? '',
    gpu: gpuFacts.gpu || 'none', vram: gpuFacts.vram, ram: `${Math.round(totalmem() / 2 ** 30)} GB`,
    docker_version: process.env.JOSI_DOCKER_VERSION ?? testerFile().docker_version ?? (existsSync('/.dockerenv') ? 'container' : ''), uptime: Math.floor(process.uptime()),
  };
}

export async function buildReport(args: { type: ReportType; error?: unknown; stack?: unknown; note?: unknown; logs?: string[]; db?: Db }): Promise<CrashReport> {
  const error = args.error instanceof Error ? args.error : null;
  return scrubReport({ ...(await machineFacts(args.db)), type: args.type,
    error: error ? `${error.name}: ${error.message}` : args.error ?? '', stack_trace: error?.stack ?? args.stack ?? '',
    last_log_lines: args.logs ?? recentLogLines(), user_note: args.note ?? '' });
}

// ---------------------------------------------------------------- the tester token and the owner's choice

/** What the installer wrote for a tester: the token, and the Docker version when Josi runs in a container. */
function testerFile(): { token?: string; docker_version?: string } {
  try { return JSON.parse(readFileSync(process.env.JOSI_TESTER_FILE ?? '/etc/josi/tester.json', 'utf8')) ?? {}; } catch { return {}; }
}

export function testerToken(): string | null {
  const fromEnv = process.env.JOSI_TESTER_TOKEN?.trim();
  if (fromEnv && fromEnv.length >= 20) return fromEnv;
  const token = testerFile().token;
  return typeof token === 'string' && token.length >= 20 ? token : null;
}
export const reportUrl = () => process.env.JOSI_REPORT_URL || REPORT_URL_DEFAULT;

/** `auto` is null until the owner has chosen. */
export async function crashSettings(db: Db): Promise<{ auto: boolean | null; tokenPresent: boolean }> {
  const [row] = await db.query<{ auto: boolean | null }>(`select (settings->>'crashReportsAuto')::boolean as auto from workspace limit 1`).catch(() => []);
  return { auto: row?.auto ?? null, tokenPresent: testerToken() !== null };
}
export async function setCrashAuto(db: Db, auto: boolean): Promise<void> {
  await db.query(`update workspace set settings = settings || $1::jsonb where id = true`, [json({ crashReportsAuto: auto })]);
}

// ---------------------------------------------------------------- keeping reports

export interface CrashRow { id: string; created_at: string; service: string; kind: ReportType; report: CrashReport; status: 'pending' | 'sent' | 'dismissed' | 'failed'; attempts: number; last_error: string | null }
const COLUMNS = 'id, created_at::text as created_at, service, kind, report, status, attempts, last_error';

/** Stores a report to be sent or shown. The same failure within ten minutes is stored once. */
export async function recordReport(db: Db, service: string, report: CrashReport): Promise<string | null> {
  const clean = scrubReport(report);
  if (clean.type === 'crash') {
    const [same] = await db.query<{ id: string }>(`select id from crash_reports where kind = 'crash' and service = $1 and report->>'error' = $2 and created_at > now() - interval '10 minutes' limit 1`, [service, clean.error]);
    if (same) return null;
  }
  const [row] = await db.query<{ id: string }>(`insert into crash_reports(service, kind, report) values ($1, $2, $3) returning id`, [service.slice(0, 40), clean.type, json(clean)]);
  // A runaway failure must not fill the database: keep the newest fifty waiting.
  await db.query(`delete from crash_reports where status = 'pending' and id not in (select id from crash_reports where status = 'pending' order by created_at desc limit 50)`);
  return row.id;
}

export const listPending = (db: Db) => db.query<CrashRow>(`select ${COLUMNS} from crash_reports where status = 'pending' order by created_at desc limit 20`);

export interface SendResult { ok: boolean; retry: boolean; status: number; message: string }

/** Posts a report. A refusal that will not change (a bad or revoked token, a rejected report) is not retried. */
export async function sendReport(report: CrashReport, opts: { fetchImpl?: typeof fetch; token?: string | null; url?: string } = {}): Promise<SendResult> {
  const token = opts.token === undefined ? testerToken() : opts.token;
  if (!token) return { ok: false, retry: false, status: 0, message: 'This installation has no tester token.' };
  const clean = scrubReport(report);
  const body = JSON.stringify({ token, ...clean });
  if (Buffer.byteLength(body) > REPORT_MAX_BYTES) return { ok: false, retry: false, status: 413, message: 'The report is too large.' };
  try {
    const response = await (opts.fetchImpl ?? fetch)(opts.url ?? reportUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) });
    if (response.ok) return { ok: true, retry: false, status: response.status, message: '' };
    const retry = response.status === 429 || response.status >= 500;
    return { ok: false, retry, status: response.status, message: response.status === 401 || response.status === 403 ? 'The tester token was refused.' : `The report address answered ${response.status}.` };
  } catch { return { ok: false, retry: true, status: 0, message: 'The report address could not be reached.' }; }
}

const BACKOFF_MINUTES = [1, 5, 30, 120, 360];

/** Marks the outcome of one send on its row: sent, to be retried later, or given up on. */
export async function settleSend(db: Db, id: string, result: SendResult): Promise<void> {
  if (result.ok) { await db.query(`update crash_reports set status = 'sent', sent_at = now(), last_error = null, attempts = attempts + 1 where id = $1`, [id]); return; }
  // A retryable failure waits longer each time (1, 5, 30, 120, then 360 minutes) and is given up on after eight tries.
  await db.query(`update crash_reports set attempts = attempts + 1, last_error = $2,
      status = case when $3::boolean and attempts + 1 < 8 then 'pending' else 'failed' end,
      next_try_at = now() + make_interval(mins => (array[${BACKOFF_MINUTES.join(',')}])[least(attempts + 1, ${BACKOFF_MINUTES.length})]) where id = $1`,
  [id, result.message.slice(0, 200), result.retry]);
}

/** Sends what is waiting and due, if the owner allows automatic reports. Returns how many went. */
export async function flushCrashReports(db: Db, opts: { fetchImpl?: typeof fetch; token?: string | null; url?: string } = {}): Promise<number> {
  const settings = await crashSettings(db);
  if (settings.auto !== true || !(opts.token ?? testerToken())) return 0;
  const due = await db.query<CrashRow>(`select ${COLUMNS} from crash_reports where status = 'pending' and next_try_at <= now() order by created_at limit 5`);
  let sent = 0;
  for (const row of due) {
    const result = await sendReport(row.report, opts);
    await settleSend(db, row.id, result);
    if (result.ok) sent++;
    else if (result.retry) break; // offline: try the rest later
  }
  return sent;
}

// ---------------------------------------------------------------- the process hooks

function queueDir(service: string): string {
  return process.env.JOSI_CRASH_QUEUE_DIR || join(resolveDataPath('/data/logs'), service, 'crash-queue');
}

/** When the database cannot be reached (often why the process is dying) the report waits as a file. */
function queueToDisk(service: string, report: CrashReport): void {
  try {
    const dir = queueDir(service);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${Date.now()}-${randomUUID()}.json`), JSON.stringify(report), { mode: 0o600 });
  } catch { /* nowhere to write: the report is lost, the process still exits */ }
}

/** Files left by a process that could not reach the database, put into it. */
export async function importQueuedReports(db: Db, service: string): Promise<number> {
  const dir = queueDir(service);
  let count = 0;
  try {
    for (const name of readdirSync(dir).filter(file => file.endsWith('.json')).slice(0, 20)) {
      const file = join(dir, name);
      try { if (await recordReport(db, service, scrubReport(JSON.parse(readFileSync(file, 'utf8'))))) count++; } finally { try { unlinkSync(file); } catch { /* gone */ } }
    }
  } catch { /* no queue */ }
  return count;
}

/** Turns an uncaught error or a rejected promise in this process into a stored report, then lets the process end as it would have. */
export function installCrashHandlers(service: string, db: () => Db | null): void {
  captureLogs();
  const handle = (kind: string) => (reason: unknown) => {
    void (async () => {
      const error = reason instanceof Error ? reason : new Error(`${kind}: ${String(reason)}`);
      console.error(`josi-ce: ${kind}:`, error.stack ?? error.message);
      try {
        const database = db();
        const report = await buildReport({ type: 'crash', error, db: database ?? undefined });
        let stored = false;
        if (database) {
          try {
            await Promise.race([recordReport(database, service, report), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('the database is slow')), 3000))]);
            stored = true;
          } catch { stored = false; }
        }
        if (!stored) queueToDisk(service, report);
      } catch { /* reporting must never be the second crash */ }
      if (kind === 'uncaughtException') process.exit(1);
    })();
  };
  process.on('uncaughtException', handle('uncaughtException'));
  process.on('unhandledRejection', handle('unhandledRejection'));
}
