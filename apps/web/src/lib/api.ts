// The only place this app talks to the server.
//
// Two things it always does, because forgetting either is a bug that looks like
// something else entirely:
//
//   * `credentials: 'same-origin'` — the session is a cookie.
//   * the CSRF cookie echoed into the header on every state-changing request,
//     which is the double-submit pair the API requires. A missing header comes
//     back as 403, which reads like an authorization bug and is not one.
import { captureSetupHandoff } from './setupHandoff';

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body?: unknown) {
    super(message);
  }
}

const SETUP_HANDOFF_KEY = 'josi_setup_handoff';
let launchToken = typeof window === 'undefined' ? null : captureSetupHandoff(window.location, history, sessionStorage);
let handoffConsumption: Promise<void> | null = null;
let csrfPriming: Promise<void> | null = null;

export function consumeSetupHandoff(): Promise<void> {
  if (!handoffConsumption) handoffConsumption = (async () => {
    if (!launchToken) return;
    const token = launchToken; launchToken = null;
    sessionStorage.removeItem(SETUP_HANDOFF_KEY);
    await primeCsrf();
    const res = await fetch('/api/onboarding/consume', { method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'x-josi-csrf': csrfToken() ?? '' }, body: JSON.stringify({ token }) });
    if (!res.ok) throw new ApiError(res.status, 'This setup link could not be used. Reopen Josi to resume setup safely.');
  })();
  return handoffConsumption;
}

function setupHandoffToken(): string | null {
  return sessionStorage.getItem(SETUP_HANDOFF_KEY);
}

export function setupHandoffHeaders(): Record<string, string> {
  const token = setupHandoffToken();
  return token ? { 'x-josi-setup-token': token } : {};
}

export function clearSetupHandoff(): void {
  sessionStorage.removeItem(SETUP_HANDOFF_KEY);
}

function csrfToken(): string | null {
  const match = /(?:^|;\s*)josi_csrf=([^;]+)/.exec(document.cookie);
  return match ? decodeURIComponent(match[1]) : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  await consumeSetupHandoff();
  const headers: Record<string, string> = setupHandoffHeaders();
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = csrfToken();
  if (token) headers['x-josi-csrf'] = token;

  const res = await fetch(`/api${path}`, {
    method,
    headers,
    credentials: 'same-origin',
    // Bypass the HTTP cache entirely, INCLUDING cached redirects. A `308
    // Permanent Redirect` to https:// once served by a misconfigured proxy is
    // cached per-URL and replayed by the browser forever — on a plain-HTTP LAN
    // install nothing answers on 443, so those requests died and the pages
    // that made them spun. Nothing this client fetches benefits from HTTP
    // caching; every response here is state.
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return undefined as T;
  const parsed = await res.json().catch(() => null);
  if (!res.ok) {
    // The server writes its errors for people. Passing one through beats
    // inventing a friendlier sentence that says less.
    const message = (parsed as { error?: string })?.error ?? `Request failed (${res.status})`;
    throw new ApiError(res.status, message, parsed);
  }
  return parsed as T;
}

async function upload<T>(path: string, body: FormData): Promise<T> {
  await consumeSetupHandoff();
  const headers: Record<string, string> = setupHandoffHeaders();
  const token = csrfToken(); if (token) headers['x-josi-csrf'] = token;
  const res = await fetch(`/api${path}`, { method: 'POST', headers, body, credentials: 'same-origin', cache: 'no-store' });
  const parsed = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(res.status, (parsed as { error?: string })?.error ?? `Request failed (${res.status})`, parsed);
  return parsed as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
  upload,
};

/** Fetches the CSRF cookie before the first state-changing request. The login
 * form needs this: there is no session yet, so nothing has set the pair. */
export function primeCsrf(): Promise<void> {
  // AuthProvider and the launch exchange mount together. Rotating two CSRF
  // cookies concurrently could invalidate the exchange's header before POST.
  if (!csrfPriming) csrfPriming = fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' })
    .then(() => undefined).catch(() => undefined).finally(() => { csrfPriming = null; });
  return csrfPriming;
}

// ---------------------------------------------------------------- shapes

export interface User {
  id: string;
  email: string;
  username: string;
  display_name: string | null;
  role: 'super_admin' | 'member';
  status: string;
}

export interface Thread {
  id: string;
  title: string | null;
  status: 'open' | 'closed';
  last_activity_at: string;
  created_at: string;
}

export interface Message {
  id: string;
  thread_id: string;
  direction: 'in' | 'out';
  channel: string;
  body: string;
  meta?: { attachments?: Array<{ id: string; filename: string; contentType: string }> };
  created_at: string;
}

export interface Task {
  id: string;
  template_key: string;
  state: string;
  slots: Record<string, unknown>;
  attempt_count: number;
  next_wake_at: string | null;
  due_at: string | null;
  fail_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRun {
  id: string;
  thread_id: string;
  thread_title: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  attempt_of: string | null;
  error_code: string | null;
  error_retryable: boolean | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskActivity {
  events: Array<{ id: string; actor: string; kind: string; payload: Record<string, unknown>; created_at: string }>;
  attempts: Array<{ id: string; kind: string; outcome: string | null; started_at: string; ended_at: string | null }>;
  approvals: Array<{ id: string; action: string; summary: string; status: string; created_at: string; decided_at: string | null }>;
}

export interface Reminder {
  id: string;
  body: string;
  due_at: string;
  status: 'scheduled' | 'delivered' | 'cancelled' | 'failed';
  delivered_at: string | null;
  created_at: string;
}

export interface TaskType {
  key: string;
  name: string;
  contract: { slots: { required: string[]; optional?: string[] } };
  requiresCapability: string | null;
}

export interface Approval {
  id: string;
  task_id: string;
  action: string;
  action_class: string;
  summary: string;
  status: string;
  created_at: string;
}

export interface Contact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  created_at: string;
  /** Where it came from. 'josi' for one somebody typed here. */
  source?: string;
  /** Which connected account, so two Google accounts are distinguishable. */
  source_account?: string | null;
  /** Set when both sides changed since the last sync and nothing was
   * overwritten. */
  conflict_state?: string | null;
  synced_at?: string | null;
}

export interface LlmStatus {
  ready: boolean;
  localOnly: boolean;
  disabledFeatures: Array<{ feature: string; reason: string }>;
  usage: {
    month: string; totalTokens: number; reportedCostUsd: number;
    estimatedCostUsd: number; selfHostedCalls: number; calls: number; notes: string[];
  };
  cap: { allowed: boolean; status: string; scope: string | null; fraction: number | null; message: string };
}

export interface TurnResult {
  reply?: string;
  refusal?: { reason: string; message: string };
}
