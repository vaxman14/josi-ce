// How much a local model can actually take in, asked of the server rather than
// guessed.
//
// The capability check only shows that about 8,000 tokens survive a round
// trip. That is not the model's context: Ollama runs every model at whatever
// `num_ctx` it was created or loaded with, a request over that fails outright,
// and nothing in the OpenAI-shaped interface lets Josi raise it. So the number
// is read from the server's own interfaces, in the order of how exact they are:
//
//   Ollama     /api/ps    the context the model is loaded with right now
//              /api/show  the `num_ctx` it was created with
//   llama.cpp  /props     the running server's n_ctx
//   others     /v1/models a context field on the model's entry, where given
//
// A server that answers none of these leaves the number unknown, which is
// shown as unknown. Only hosts the operator already pointed Josi at are asked.
import type { Db } from '@josi-ce/core';
import { json } from '@josi-ce/core';
import { safeFetch, type SafeFetchOptions } from './ssrf.js';
import type { PromptSize } from './promptSize.js';
import type { StoredProvider } from './registry.js';

export interface ModelContext {
  provider: string;
  model: string;
  baseUrl: string;
  /** The context in tokens the model runs with, or null when unknown. */
  tokens: number | null;
  /** Where the number came from, in words an operator recognises. */
  source: string;
  /** The largest context the model's weights support, when the server says. */
  trainedMax: number | null;
  at: string;
}

export interface DetectOptions {
  baseUrl: string;
  model: string;
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
  timeoutMs?: number;
}

const count = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) && n >= 256 && n < 100_000_000 ? Math.round(n) : null;
};

/** `name` and `name:latest` are the same model to Ollama. */
const sameModel = (a: unknown, b: string) => typeof a === 'string'
  && (a === b || a === `${b}:latest` || `${a}:latest` === b);

export async function detectModelContext(opts: DetectOptions): Promise<{ tokens: number | null; source: string; trainedMax: number | null }> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const root = base.replace(/\/v1$/, '');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  const fetchOpts = { timeoutMs: opts.timeoutMs ?? 4000, fetchImpl: opts.fetchImpl, resolve: opts.resolve };
  const ask = async (url: string, body?: unknown): Promise<Record<string, unknown> | null> => {
    try {
      const res = await safeFetch(url, body === undefined ? { method: 'GET', headers } : { method: 'POST', headers, body: JSON.stringify(body) }, fetchOpts);
      if (!res.ok) return null;
      const parsed = JSON.parse(await res.text()) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
    } catch { return null; }
  };

  let trainedMax: number | null = null;

  // Ollama, loaded right now: the exact answer.
  const ps = await ask(`${root}/api/ps`);
  const running = Array.isArray(ps?.models) ? (ps.models as Array<Record<string, unknown>>).find((m) => sameModel(m.name, opts.model) || sameModel(m.model, opts.model)) : undefined;
  const loaded = count(running?.context_length);

  // Ollama, as created.
  const show = ps ? await ask(`${root}/api/show`, { model: opts.model }) : null;
  let created: number | null = null;
  if (show) {
    const info = show.model_info && typeof show.model_info === 'object' ? show.model_info as Record<string, unknown> : {};
    for (const [key, value] of Object.entries(info)) if (key.endsWith('.context_length')) trainedMax = count(value);
    const parameters = typeof show.parameters === 'string' ? show.parameters : '';
    const m = /^\s*num_ctx\s+(\d+)/m.exec(parameters);
    if (m) created = count(m[1]);
  }
  if (loaded) return { tokens: loaded, source: 'the model as Ollama has it loaded now', trainedMax };
  if (created) return { tokens: created, source: 'the num_ctx the model was created with in Ollama', trainedMax };
  if (ps) return { tokens: null, source: 'Ollama did not say: the model has no num_ctx of its own and is not loaded, so the server default applies', trainedMax };

  // llama.cpp server.
  const props = await ask(`${root}/props`);
  const settings = props?.default_generation_settings && typeof props.default_generation_settings === 'object'
    ? props.default_generation_settings as Record<string, unknown> : null;
  const nCtx = count(settings?.n_ctx) ?? count(props?.n_ctx);
  if (nCtx) return { tokens: nCtx, source: 'the running llama.cpp server', trainedMax };

  // vLLM, LM Studio and friends put it on the model's entry, under their own names.
  const listing = await ask(`${base}/models`);
  const entry = Array.isArray(listing?.data) ? (listing.data as Array<Record<string, unknown>>).find((m) => m.id === opts.model) : undefined;
  const listed = count(entry?.max_model_len) ?? count(entry?.context_length) ?? count(entry?.context_window)
    ?? count(entry?.loaded_context_length) ?? count(entry?.max_context_length);
  if (listed) return { tokens: listed, source: 'the model list of your server', trainedMax };

  return { tokens: null, source: 'your model server does not report it', trainedMax };
}

const sameSelection = (c: ModelContext | null | undefined, stored: StoredProvider) =>
  !!c && c.provider === stored.provider && c.model === stored.model && c.baseUrl === (stored.base_url ?? '');

/** What was last learned about the selected model's context, if it still
 * describes the model that is selected. */
export async function loadModelContext(db: Db, stored: StoredProvider | null): Promise<ModelContext | null> {
  if (!stored) return null;
  const [row] = await db.query<{ settings: Record<string, unknown> | null }>('select settings from workspace where id = true').catch(() => []);
  const saved = row?.settings?.modelContext as ModelContext | undefined;
  return sameSelection(saved, stored) ? saved! : null;
}

async function saveModelContext(db: Db, context: ModelContext): Promise<void> {
  await db.query('insert into workspace (id, settings) values (true, $1::jsonb) on conflict (id) do update set settings = workspace.settings || excluded.settings', [json({ modelContext: context })]).catch(() => undefined);
}

/** Ask the server and remember the answer. Only for a model on the operator's
 * own hardware: a hosted vendor's context is not a setting anyone can get wrong. */
export async function refreshModelContext(
  db: Db, stored: StoredProvider, net: { apiKey?: string | null; fetchImpl?: typeof fetch; resolve?: SafeFetchOptions['resolve'] } = {},
): Promise<ModelContext | null> {
  if (stored.provider !== 'openai_compatible' || !stored.base_url) return null;
  const found = await detectModelContext({ baseUrl: stored.base_url, model: stored.model, ...net });
  const context: ModelContext = { provider: stored.provider, model: stored.model, baseUrl: stored.base_url ?? '', ...found, at: new Date().toISOString() };
  await saveModelContext(db, context);
  return context;
}

/** The server said a request did not fit and named its context: that is the
 * most direct evidence there is, so it is remembered. */
export async function rememberOverflowContext(db: Db, stored: StoredProvider, contextTokens: number | null | undefined): Promise<void> {
  if (!contextTokens || stored.provider !== 'openai_compatible') return;
  await saveModelContext(db, { provider: stored.provider, model: stored.model, baseUrl: stored.base_url ?? '', tokens: contextTokens,
    source: 'the model server, when it turned down a request that was too large', trainedMax: null, at: new Date().toISOString() });
}

/** Under this, a local model gets the compact prompt unless told otherwise. */
export const COMPACT_BELOW_TOKENS = 32_000;

export type PromptProfile = 'full' | 'compact';

/** Which prompt a turn is built with. Only a model on the operator's own
 * hardware can be compact; the choice is theirs, and "automatic" goes by the
 * context the server reported. An unknown context counts as small: the
 * failure that costs a reply is the request that does not fit. */
export function promptProfile(stored: StoredProvider | null, context: ModelContext | null): PromptProfile {
  if (!stored || stored.provider !== 'openai_compatible') return 'full';
  const choice = stored.provider_config?.prompt;
  if (choice === 'full' || choice === 'compact') return choice;
  return context?.tokens && context.tokens >= COMPACT_BELOW_TOKENS ? 'full' : 'compact';
}

export interface LastPrompt extends PromptSize {
  provider: string;
  model: string;
  profile: PromptProfile;
  /** How many tools were offered out of how many were available. */
  toolsOffered: number;
  toolsAvailable: number;
  at: string;
}

/** The size of the most recent chat request, for the Models page. Sizes only. */
export async function recordLastPrompt(db: Db, prompt: LastPrompt): Promise<void> {
  await db.query('insert into workspace (id, settings) values (true, $1::jsonb) on conflict (id) do update set settings = workspace.settings || excluded.settings', [json({ lastPrompt: prompt })]).catch(() => undefined);
}

export async function loadLastPrompt(db: Db, stored: StoredProvider | null): Promise<LastPrompt | null> {
  if (!stored) return null;
  const [row] = await db.query<{ settings: Record<string, unknown> | null }>('select settings from workspace where id = true').catch(() => []);
  const saved = row?.settings?.lastPrompt as LastPrompt | undefined;
  return saved && saved.provider === stored.provider && saved.model === stored.model ? saved : null;
}

/** Whether Josi makes its own model calls around a conversation: learning
 * facts from a message after the reply, and reviewing what went wrong into
 * suggestions.
 *
 * A hosted model answers those beside the conversation and nobody notices. A
 * model on the person's own hardware is one model with one memory of what it
 * last read: every such call pushes the conversation out of it, and the next
 * message is read again from the first token. So for a local model they are
 * off unless the operator turns them on. Keeping a long conversation's summary
 * is not one of these: without it the conversation would stop fitting. */
export function backgroundModelWork(stored: StoredProvider | null): boolean {
  if (!stored) return false;
  if (stored.provider !== 'openai_compatible') return true;
  return stored.provider_config?.background === 'on';
}
