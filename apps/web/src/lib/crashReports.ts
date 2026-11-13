// The browser's side of crash reports: tell the server when the page itself crashes.
//
// The server scrubs and stores the report and decides what happens to it (sent
// by itself, or shown to the owner on a card). All this does is say "the page
// crashed" once per distinct failure, never more than a few times a visit, and
// never about anything the person typed: only the error's own message and stack.
import { api } from '@/lib/api';

const MAX_PER_VISIT = 3;
const told = new Set<string>();

/** Tells the server about a crash in this page. Quiet and safe to call from anywhere. */
export function reportBrowserCrash(error: unknown, post: (message: string, stack: string) => Promise<unknown> = (message, stack) => api.post('/crash-reports/client', { message, stack })): boolean {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error ?? 'unknown');
  const stack = error instanceof Error ? error.stack ?? '' : '';
  const key = message.slice(0, 200);
  if (told.has(key) || told.size >= MAX_PER_VISIT) return false;
  told.add(key);
  void Promise.resolve(post(message, stack)).catch(() => undefined);
  return true;
}

let installed = false;
/** Reports errors that nothing caught. Once per page load. */
export function installBrowserCrashReporting(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', event => { if (event.error) reportBrowserCrash(event.error); });
  window.addEventListener('unhandledrejection', event => reportBrowserCrash(event.reason));
}

/** For tests. */
export const forgetBrowserCrashes = () => told.clear();

export interface CrashSettings { auto: boolean | null; tokenPresent: boolean; defaultAuto: boolean | null }
export interface PendingReport { id: string; createdAt: string; service: string; kind: 'crash' | 'feedback'; report: Record<string, unknown> }
export interface CrashState { settings: CrashSettings; pending: PendingReport[] }

export const loadCrashState = () => api.get<CrashState>('/crash-reports');
export const setAutoReports = (auto: boolean) => api.put<{ settings: CrashSettings }>('/crash-reports/settings', { auto });
export const sendPendingReport = (id: string, report: Record<string, unknown>) => api.post<{ ok: boolean; message: string }>(`/crash-reports/${id}/send`, { report });
export const dismissPendingReport = (id: string) => api.post<{ ok: boolean }>(`/crash-reports/${id}/dismiss`, {});
export const startFeedback = (note: string) => api.post<PendingReport>('/crash-reports/feedback', { note });

/** The report as text to read and edit, and back. A bad edit is refused with a plain reason. */
export const reportToText = (report: Record<string, unknown>) => JSON.stringify(report, null, 2);
export function textToReport(text: string): { ok: true; report: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, message: 'The report must stay a JSON object.' };
    return { ok: true, report: value as Record<string, unknown> };
  } catch { return { ok: false, message: 'The report is not valid JSON any more. Fix it, or put it back as it was.' }; }
}
