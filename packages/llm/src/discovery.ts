// Which models this account can actually use.
//
// The thing this replaces was a hardcoded list in the web app. It offered
// `gpt-5.6-terra` and `gpt-5.6-luna` to everyone, whether or not the account
// had ever been granted them, whether or not they existed — and an operator who
// picked one found out at the first real request, long after setup said it was
// configured.
//
// So the list is asked for. Every provider CE supports has a models endpoint,
// it is scoped to the credential presented, and that is the whole point: the
// answer is what THIS key on THIS organization may call, which is a question no
// catalog in this repository can answer.
//
// Two things are deliberately NOT done here:
//
//   * No model is called. Discovery lists; the probe proves. A model that
//     appears here has not been shown to work, and `activated_at` still gates
//     use on a real request succeeding.
//   * Nothing is invented. If discovery fails, this returns the failure and its
//     category. It never falls back to a built-in list, because falling back to
//     a guess is exactly the behaviour being removed.
import {
  LlmError, categorizeFailure, explainCategory,
  type LlmErrorCategory, type ProviderKind,
} from './types.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from './ssrf.js';
import { safeErrorCode } from './providers/openaiCompatible.js';

export interface DiscoveredModel {
  /** Exactly what the provider calls it. This is what gets stored and sent. */
  id: string;
  /** A human-readable name, for the ordinary view. */
  label: string;
  /** The provider's own display name where it gave one, otherwise derived. */
  fromProvider: boolean;
  /** Josi's suggestion, not the provider's. Highest-capability first. */
  recommended: boolean;
  /** Set when the model is almost certainly not a chat model. Hidden from the
   * ordinary list and shown under "show everything". */
  likelyNonChat: boolean;
}

export interface DiscoveryResult {
  ok: boolean;
  models: DiscoveredModel[];
  /** Present when ok is false. */
  category?: LlmErrorCategory;
  message?: string;
  providerCode?: string;
  /** True when this provider has no listing interface at all, which is a
   * different thing from a listing that failed. */
  unsupported?: boolean;
}

export interface DiscoverOptions {
  provider: ProviderKind;
  apiKey?: string | null;
  baseUrl?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
}

const DEFAULT_BASE: Partial<Record<ProviderKind, string>> = {
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  cohere: 'https://api.cohere.com/v2',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  mistral: 'https://api.mistral.ai/v1',
  kimi: 'https://api.moonshot.ai/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  openrouter: 'https://openrouter.ai/api/v1',
  minimax: 'https://api.minimax.io/v1',
};

/** Model families that are not chat models, whatever else they are.
 *
 * OpenAI's `/models` returns everything the account can touch, which includes
 * embeddings, speech, transcription and image generation. Offering
 * `text-embedding-3-small` as the model Josi thinks with is worse than offering
 * nothing, so these are filtered out of the ordinary list.
 *
 * This IS a heuristic and it is labelled as one: a match sets `likelyNonChat`
 * rather than dropping the row, and the advanced view shows everything. A
 * future model whose name matches one of these patterns is hidden, not lost. */
const NON_CHAT = [
  /embedding/i, /^tts-/i, /^whisper/i, /^dall-e/i, /^gpt-image/i, /moderation/i,
  /^text-moderation/i, /-audio(-|$)/i, /-realtime(-|$)/i, /^omni-moderation/i,
  /^codex-mini/i, /-transcribe(-|$)/i, /^sora/i, /guard/i, /-tts(-|$)/i,
];

function looksNonChat(id: string): boolean {
  return NON_CHAT.some((p) => p.test(id));
}

/** A readable name for an identifier nobody chose for readability.
 *
 * Derived rather than looked up, because the ids are discovered: a table would
 * have an entry for every model that existed when it was written and nothing
 * for the one released last week, which is the failure this whole module is
 * about. */
export function humanizeModelId(id: string): string {
  return id
    .replace(/[-_]/g, ' ')
    .replace(/\bgpt\b/gi, 'GPT')
    .replace(/\bo(\d)\b/gi, 'o$1')
    .replace(/\bclaude\b/gi, 'Claude')
    .replace(/\bgrok\b/gi, 'Grok')
    .replace(/\bllama\b/gi, 'Llama')
    .replace(/\bmistral\b/gi, 'Mistral')
    .replace(/\bqwen\b/gi, 'Qwen')
    .replace(/\bdeepseek\b/gi, 'DeepSeek')
    .replace(/\bmini\b/gi, 'Mini')
    .replace(/\bnano\b/gi, 'Nano')
    .replace(/\bturbo\b/gi, 'Turbo')
    .replace(/\bopus\b/gi, 'Opus')
    .replace(/\bsonnet\b/gi, 'Sonnet')
    .replace(/\bhaiku\b/gi, 'Haiku')
    .replace(/\binstruct\b/gi, 'Instruct')
    .replace(/\blatest\b/gi, '(latest)')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Which of the discovered models to put at the top.
 *
 * A preference between real options, not a claim about what exists. If the
 * account has none of these, nothing is marked recommended and the list is
 * simply the list. */
const PREFERRED = [/opus/i, /sonnet/i, /^gpt-\d/i, /^o\d/i, /grok-\d/i];

function markRecommended(models: DiscoveredModel[]): void {
  const chat = models.filter((m) => !m.likelyNonChat);
  for (const pattern of PREFERRED) {
    const hit = chat.find((m) => pattern.test(m.id));
    if (hit) { hit.recommended = true; return; }
  }
}

interface ListRow { id?: unknown; display_name?: unknown }

function toModels(rows: ListRow[]): DiscoveredModel[] {
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const provided = typeof row.display_name === 'string' && row.display_name.trim()
      ? row.display_name.trim()
      : '';
    models.push({
      id,
      label: provided || humanizeModelId(id),
      fromProvider: !!provided,
      recommended: false,
      likelyNonChat: looksNonChat(id),
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id));
  markRecommended(models);
  return models;
}

const failure = (
  category: LlmErrorCategory,
  message?: string,
  providerCode?: string,
): DiscoveryResult => ({ ok: false, models: [], category, message: message ?? explainCategory(category), providerCode });

/** Ask the provider what this credential may use. */
export async function discoverModels(opts: DiscoverOptions): Promise<DiscoveryResult> {
  if (opts.provider === 'openai_subscription') {
    // There is no listing interface here and inventing one would mean guessing.
    // The Codex CLI selects the model for the operator's plan; Josi does not
    // choose it and does not pretend to offer a choice.
    return {
      ok: true,
      models: [],
      unsupported: true,
      message:
        'The Codex CLI chooses the model for your ChatGPT plan. There is nothing to select here, '
        + 'and Josi will confirm it works by making a real request.',
    };
  }

  if (opts.provider === 'anthropic_subscription') {
    // There is no listing interface on the subscription path either — but
    // unlike Codex, the CLI DOES take a model, so claiming there is nothing to
    // choose would be false in the other direction.
    //
    // These are the aliases the CLI's own `--model` documents, not a catalogue
    // Josi discovered and not a guess at what a plan includes. Which of them a
    // particular Claude plan can actually reach is between the operator and
    // Anthropic, so nothing here is marked available: Josi confirms the one
    // that was chosen by making a real request, exactly as it does elsewhere.
    const aliases = [
      { id: 'opus', label: 'Opus — most capable' },
      { id: 'sonnet', label: 'Sonnet — balanced' },
      { id: 'haiku', label: 'Haiku — fastest' },
    ];
    return {
      ok: true,
      models: aliases.map((a, index) => ({
        id: a.id,
        label: a.label,
        // These come from the CLI's documented aliases rather than from a
        // provider listing call, and the flag says so rather than implying an
        // API answered.
        fromProvider: false,
        recommended: index === 1,
        likelyNonChat: false,
      })),
      message:
        'These are the model aliases Claude Code accepts. A full model name works too. Which ones '
        + 'your plan can reach is between you and Anthropic — Josi will confirm your choice by '
        + 'making a real request.',
    };
  }

  const base = (opts.baseUrl || DEFAULT_BASE[opts.provider] || '').replace(/\/$/, '');
  if (!base) {
    return failure('malformed_request', 'No endpoint is configured for this provider.');
  }

  const headers: Record<string, string> = {};
  if (opts.provider === 'anthropic') {
    if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (opts.provider === 'gemini') {
    if (opts.apiKey) headers['x-goog-api-key'] = opts.apiKey;
  } else if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  let res: Response;
  try {
    res = await safeFetch(`${base}/models`, { method: 'GET', headers }, {
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      resolve: opts.resolve,
    });
  } catch (err) {
    if (err instanceof UnsafeEndpointError) {
      return failure('malformed_request', err.message);
    }
    return failure('network');
  }

  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const providerCode = safeErrorCode(text);
    const category = categorizeFailure(res.status, providerCode);
    return failure(category, explainCategory(category), providerCode);
  }

  let parsed: { data?: unknown; models?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return failure('malformed_request', 'The endpoint answered, but not with a model list Josi could read.');
  }

  // OpenAI, Anthropic and xAI all use `data`. Some self-hosted runtimes use
  // `models`. Anything else is a runtime that does not speak this API.
  const rows = Array.isArray(parsed.data) ? parsed.data
    : Array.isArray(parsed.models) ? parsed.models.map((row: unknown) => {
      if (!row || typeof row !== 'object') return row;
      const record = row as Record<string, unknown>;
      const rawId = typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : '';
      return { id: rawId.replace(/^models\//, ''), display_name: record.display_name ?? record.displayName ?? record.name };
    })
    : null;
  if (!rows) {
    return {
      ...failure(
        'malformed_request',
        'The endpoint answered, but its reply is not an OpenAI-compatible model list.',
      ),
      unsupported: true,
    };
  }

  return { ok: true, models: toModels(rows as ListRow[]) };
}

/** Turn a discovery failure into the error the rest of CE throws. */
export function discoveryError(result: DiscoveryResult): LlmError {
  return new LlmError(result.message ?? 'models could not be listed', {
    category: result.category ?? 'unknown',
    providerCode: result.providerCode,
    needsReconfiguration:
      result.category === 'authentication'
      || result.category === 'authorization'
      || result.category === 'billing',
    retryable: result.category === 'rate_limit' || result.category === 'provider_outage' || result.category === 'network',
  });
}
