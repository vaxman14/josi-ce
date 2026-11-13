// One chat message as a durable turn, the way the Windows app sends it.
//
// The old web path was one blocking POST /talk: nothing on screen until the
// whole turn finished, and a long task (reading mail through a tunnel) could
// run into a proxy's request limit. A durable turn is accepted at once
// (202); the worker writes what Josi is doing into the turn, a stream pushes
// it ("Checking your calendar…"), and the reply is shown the moment it is
// saved. If the stream drops, the same facts are polled.
import { api, ApiError, type Message } from '@/lib/api';

export interface TurnOutcome { status: 'completed' | 'failed'; messageId: string | null; error: string | null }

/** What Josi is doing, from a progress record the worker wrote:
 * a sentence she said along the way, or a tool line such as "Reading the page". */
export function activityText(progress: unknown): string {
  const value = (progress ?? {}) as { phase?: string; detail?: string };
  const detail = typeof value.detail === 'string' ? value.detail.trim() : '';
  if (!detail) return '';
  return value.phase === 'said' ? detail : `${detail}…`;
}

const newId = () => (globalThis.crypto && 'randomUUID' in globalThis.crypto)
  ? globalThis.crypto.randomUUID()
  : `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

/** Words for a turn that failed, as the Windows app says them. */
export function failureMessage(code: string | null): string {
  switch (code) {
    case 'no_model': return 'No model is configured for this server.';
    case 'not_probed': return 'The saved model must pass its capability check before it can answer.';
    case 'cannot_chat': return 'The saved model did not pass its basic reply check.';
    case 'capped': return 'The model cannot run with its current connection or usage settings. Check the subscription or API connection and the model limits.';
    case 'context_overflow': return 'This message was too large for the model. The sizes and what to do are in the note Josi left in this conversation and under Models, Size and speed.';
    case 'provider_error': return 'The model provider could not complete this reply. Check its connection and run the model capability check.';
    case 'session_expired': return 'Your sign-in expired before this message could run. Sign in again to continue.';
    case 'worker_interrupted': return 'The server stopped before this reply finished.';
    case 'effect_outcome_unknown':
    case 'effect_then_provider_error': return 'Josi could not finish the reply after starting an action. Look at what she did before asking her to continue.';
    case 'restricted': return 'The current permissions do not allow Josi to answer this request.';
    default: return 'The server could not finish this reply. Check System checkup for more information.';
  }
}

/** Submit a message; resolves with the accepted turn's id. */
/** `replyTo` is the assistant message on screen when the person sent this.
 * A typed yes or no approves or denies only the request in that message. */
export async function submitTurn(threadId: string, message: string, attachmentIds: string[], replyTo?: string | null): Promise<string> {
  const accepted = await api.post<{ turn: { id: string } }>(`/assistant/threads/${threadId}/turns`, {
    client_message_id: newId(), message, attachment_receipts: attachmentIds,
    ...(replyTo ? { reply_to_message_id: replyTo } : {}),
  });
  return accepted.turn.id;
}

interface PolledTurn { id: string; status: string; assistant_message_id: string | null; error_code: string | null; progress?: unknown }

/** Follow one turn to its end, reporting what Josi is doing. Never throws on a
 * dropped stream: it polls instead. Rejects only when the turn cannot be found
 * or `signal` aborts. */
export function followTurn(threadId: string, turnId: string, onActivity: (text: string) => void, signal?: AbortSignal): Promise<TurnOutcome> {
  return new Promise<TurnOutcome>((resolve, reject) => {
    let settled = false, source: EventSource | null = null, poller: ReturnType<typeof setTimeout> | null = null;
    const finish = (outcome: TurnOutcome) => { if (settled) return; settled = true; cleanup(); resolve(outcome); };
    const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
    const cleanup = () => { source?.close(); source = null; if (poller) clearTimeout(poller); signal?.removeEventListener('abort', onAbort); };
    const onAbort = () => fail(new DOMException('aborted', 'AbortError'));
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) { onAbort(); return; }

    const base = `/api/assistant/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/stream`;
    const poll = async () => {
      if (settled) return;
      try {
        const listed = await api.get<{ turns: PolledTurn[] }>(`/assistant/threads/${threadId}/turns?turn_id=${encodeURIComponent(turnId)}`);
        const turn = listed.turns.find((t) => t.id === turnId);
        if (!turn) { fail(new ApiError(404, 'no such turn', null)); return; }
        const text = activityText(turn.progress); if (text) onActivity(text);
        if (turn.status === 'completed' || turn.status === 'failed') {
          finish({ status: turn.status, messageId: turn.assistant_message_id, error: turn.error_code }); return;
        }
      } catch (error) {
        if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) { fail(error); return; }
        /* a network blip: try again */
      }
      poller = setTimeout(() => void poll(), 1500);
    };
    const fallBack = () => { source?.close(); source = null; if (!settled && !poller) void poll(); };

    if (typeof EventSource === 'undefined') { fallBack(); return; }
    try {
      source = new EventSource(base, { withCredentials: true });
      source.addEventListener('progress', (event) => {
        try { const text = activityText((JSON.parse((event as MessageEvent).data) as { progress?: unknown }).progress); if (text) onActivity(text); } catch { /* ignore a bad frame */ }
      });
      source.addEventListener('done', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { status: string; messageId: string | null; error: string | null };
          finish({ status: data.status === 'completed' ? 'completed' : 'failed', messageId: data.messageId, error: data.error });
        } catch { fallBack(); }
      });
      source.addEventListener('gone', () => fallBack());
      // A closed or refused stream (a proxy that buffers, a restart): poll.
      source.onerror = () => fallBack();
    } catch { fallBack(); }
  });
}

/** The saved reply of a finished turn. */
export async function turnReply(threadId: string, outcome: TurnOutcome): Promise<Message | null> {
  if (outcome.status !== 'completed') return null;
  const thread = await api.get<{ messages: Message[] }>(`/assistant/threads/${threadId}?recent=1`);
  return thread.messages.find((m) => m.id === outcome.messageId)
    ?? [...thread.messages].reverse().find((m) => m.direction === 'out') ?? null;
}
