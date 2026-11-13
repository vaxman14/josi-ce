// OpenAI's chat-completions shape, which OpenAI, xAI, essentially every
// self-hosted runtime, and a growing list of hosted vendors speak. One adapter
// for all of them, because the wire format is genuinely the same and
// maintaining a copy per vendor would mean maintaining a copy of every bug.
//
// Which vendors belong here is decided in `catalog.ts` by `wire: 'openai-chat'`
// and the bar is deliberately higher than "advertises an OpenAI-compatible
// endpoint": the vendor has to honour the contract Josi actually uses — nested
// `function` tool definitions, `tool_calls` returned with a `tool` role keyed
// by call id, and `response_format: {type:'json_object'}`. A vendor that
// diverges on any of those gets its own adapter instead, because a shim
// presented as native support fails at the moment somebody asks for something
// that needs a tool.
import {
  LlmError, categorizeFailure, explainCategory,
  type ChatRequest, type ChatResponse, type LlmErrorCategory, type LlmProvider, type ProviderKind, type ToolCall,
} from '../types.js';
import { describeProvider } from '../catalog.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from '../ssrf.js';
import { measureRequest } from '../promptSize.js';
import { writeLlmDebug } from '../debugLog.js';

export interface OpenAiCompatibleOptions {
  kind: ProviderKind;
  model: string;
  apiKey?: string | null;
  /** Required for `openai_compatible`, which has no default. Optional for the
   * hosted vendors: supplying one overrides the catalogue's default endpoint,
   * which is how an operator reaches a regional host. */
  baseUrl?: string | null;
  external: boolean;
  /** Ask the server not to think before answering (`reasoning_effort: "none"`).
   * Only for a model on the operator's own hardware, and only when they chose
   * it: a hosted vendor may reject the value. */
  noThinking?: boolean;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve'];
}

interface OaiMessage {
  content?: string | null;
  tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
}

interface OaiResponse {
  choices?: Array<{ message?: OaiMessage; finish_reason?: string }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

/** The chat-completions request body.
 *
 * Exported because Azure AI genuinely speaks this body — what differs there is
 * the transport around it: a per-resource host, the deployment in the path, a
 * mandatory `api-version`, and an `api-key` header instead of a bearer. Sharing
 * the translation and not the transport is the honest split; sharing the whole
 * adapter would have meant pretending a deployment is a model name. */
export function openAiChatBody(model: string, request: ChatRequest): Record<string, unknown> {
  // A tool round-trip in this dialect is: an assistant message carrying
  // `tool_calls`, then ONE `tool` message per call, keyed by call id.
  const messages: Array<Record<string, unknown>> = [
    ...(request.system ? [{ role: 'system', content: request.system }] : []),
  ];
  for (const m of request.messages) {
    if (m.toolResults?.length) {
      // The results arrive as their own messages, not as a user turn.
      for (const r of m.toolResults) {
        messages.push({ role: 'tool', tool_call_id: r.toolCallId, content: r.content });
      }
      if (m.content) messages.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.toolCalls?.length) {
      messages.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input) },
        })),
      });
      continue;
    }
    if (m.images?.length) {
      // The documented OpenAI vision shape: a content ARRAY on the user turn,
      // images as `image_url` parts carrying a data: URI. Bytes travel in the
      // request rather than as a link — CE does not ask a model vendor to go
      // and fetch a second party's storage. Text last, so the picture is
      // established context before the question about it.
      messages.push({
        role: m.role,
        content: [
          ...m.images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mediaType};base64,${img.base64}` },
          })),
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ],
      });
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }

  const body: Record<string, unknown> = {
    model,
    messages,
    max_tokens: request.maxTokens ?? 1024,
  };
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.jsonMode) body.response_format = { type: 'json_object' };
  if (request.tools?.length) {
    body.tools = request.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

/** The chat-completions response, normalised. Shared with Azure. */
export function readOpenAiChat(parsed: OaiResponse, latencyMs: number): ChatResponse {
  const message = parsed.choices?.[0]?.message;
  const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((tc, i) => {
    let input: Record<string, unknown> = {};
    try {
      input = tc.function?.arguments ? (JSON.parse(tc.function.arguments) as Record<string, unknown>) : {};
    } catch {
      // A model that emits malformed arguments has not really made a tool
      // call. Keep the name so the probe can still see the attempt.
      input = {};
    }
    return { id: tc.id ?? `call_${i}`, name: tc.function?.name ?? '', input };
  });

  return {
    text: message?.content ?? '',
    toolCalls,
    usage: {
      inputTokens: parsed.usage?.prompt_tokens ?? 0,
      outputTokens: parsed.usage?.completion_tokens ?? 0,
    },
    latencyMs,
  };
}

export function openAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  // The operator's endpoint wins where the catalogue allows one, so a vendor
  // with a regional or mainland-China host can be pointed at the right one
  // rather than being unusable for the people it was added for.
  const base = (opts.baseUrl || describeProvider(opts.kind)?.defaultBaseUrl || '').replace(/\/$/, '');
  if (!base) throw new LlmError(`no endpoint configured for ${opts.kind}`);
  // Set when this server turned down `reasoning_effort: "none"` and then
  // answered the same request without it.
  let thinkingValueRefused = false;

  return {
    kind: opts.kind,
    model: opts.model,
    external: opts.external,

    async chat(request: ChatRequest): Promise<ChatResponse> {
      const body = openAiChatBody(opts.model, request);
      const askNoThinking = !!opts.noThinking && opts.kind === 'openai_compatible' && !thinkingValueRefused;
      if (askNoThinking) body.reasoning_effort = 'none';

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // A self-hosted runtime may need no key at all; sending an empty bearer
      // makes some of them reject the request outright.
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const url = `${base}/chat/completions`;
      const send = async (payload: Record<string, unknown>): Promise<{ res: Response; text: string; latencyMs: number }> => {
        const started = Date.now();
        let res: Response;
        try {
          res = await safeFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
          }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
        } catch (err) {
          await writeLlmDebug({ provider: opts.kind, model: opts.model, url, request: payload, status: null, reply: null,
            latencyMs: Date.now() - started, error: err instanceof Error ? err.message : String(err) });
          if (err instanceof UnsafeEndpointError) {
            throw new LlmError(err.message, { needsReconfiguration: true });
          }
          // Abort or socket failure.
          throw new LlmError(explainCategory('network'), { retryable: true, category: 'network' });
        }
        const latencyMs = Date.now() - started;
        const text = await res.text().catch(() => '');
        await writeLlmDebug({ provider: opts.kind, model: opts.model, url, request: payload, status: res.status, reply: text, latencyMs });
        return { res, text, latencyMs };
      };

      let { res, text, latencyMs } = await send(body);
      // "Do not think" is on by default for a model on the operator's own
      // hardware, and not every local server knows the value. One that refuses
      // the request for it is asked again without it, once, and not asked that
      // way again by this client. A request that was too large is not that case.
      if (askNoThinking && (res.status === 400 || res.status === 422) && !contextOverflow(text)) {
        const plain = { ...body };
        delete plain.reasoning_effort;
        const again = await send(plain);
        if (again.res.ok) thinkingValueRefused = true;
        ({ res, text, latencyMs } = again);
      }

      if (!res.ok) {
        // A request larger than the model's context. The server's sentence is
        // not repeated (it is prose), only the two numbers in it; the request
        // size falls back to our own estimate.
        const overflow = contextOverflow(text);
        if (overflow) {
          const requestTokens = overflow.requestTokens ?? measureRequest(request).total;
          throw new LlmError(describeContextOverflow(opts.model, overflow.contextTokens, requestTokens, overflow.requestTokens !== null), {
            status: res.status, category: 'context_overflow', contextTokens: overflow.contextTokens, requestTokens,
          });
        }
        // The provider's own PROSE goes nowhere near the caller: it routinely
        // echoes back parts of the request, and this one contains the prompt.
        // Its short `code`/`type` is an enum member rather than prose, and it
        // is the only thing that distinguishes "slow down" from "out of
        // credit" — both of which arrive as 429.
        const providerCode = safeErrorCode(text);
        const category = categorizeFailure(res.status, providerCode);
        // The gateway's own sentence is the useful one here: it says the cap was
        // reached and what to do, where a generic billing line would send the
        // person looking for a provider account they don't have.
        const message = providerCode === ALLOWANCE_EXHAUSTED ? allowanceMessage(text) : describeFailure(res.status, category);
        throw new LlmError(message, {
          status: res.status,
          category,
          providerCode,
          needsReconfiguration: res.status === 401 || res.status === 403 || category === 'billing',
          // A quota failure is not worth retrying and not worth failing over
          // to a second provider that bills the same account.
          retryable: (res.status === 429 || res.status >= 500) && category !== 'billing',
        });
      }

      let parsed: OaiResponse;
      try {
        parsed = JSON.parse(text) as OaiResponse;
      } catch {
        throw new LlmError('the model endpoint returned something that is not valid JSON', { status: res.status });
      }

      return readOpenAiChat(parsed, latencyMs);
    },
  };
}

/** Whether an error body says the request did not fit the model's context,
 * and the numbers it gives.
 *
 * llama.cpp answers with `type: exceed_context_size_error` and two counters;
 * Ollama and the hosted vendors say it in a sentence, sometimes with the
 * numbers in it. Only numbers are taken from the sentence. */
export function contextOverflow(body: string): { contextTokens: number | null; requestTokens: number | null } | null {
  if (!body) return null;
  let message = body.slice(0, 2000);
  let type = '';
  let contextTokens: number | null = null;
  let requestTokens: number | null = null;
  const count = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 100_000_000 ? Math.round(value) : null;
  try {
    const parsed = JSON.parse(body) as { error?: unknown; n_ctx?: unknown; n_prompt_tokens?: unknown };
    const error = (parsed.error && typeof parsed.error === 'object' ? parsed.error : parsed) as Record<string, unknown>;
    if (typeof parsed.error === 'string') message = parsed.error.slice(0, 2000);
    else if (typeof error.message === 'string') message = error.message.slice(0, 2000);
    type = [error.type, error.code].filter((v) => typeof v === 'string').join(' ');
    contextTokens = count(error.n_ctx) ?? count(parsed.n_ctx);
    requestTokens = count(error.n_prompt_tokens) ?? count(parsed.n_prompt_tokens);
  } catch { /* not JSON: the text itself is searched */ }
  const says = /exceed_context_size|context_length_exceeded/i.test(type)
    || /(exceeds?|larger than|longer than|over|beyond|too long for)[^.]{0,60}context/i.test(message)
    || /context (size|length|window)[^.]{0,60}(exceed|too (small|short)|is only)/i.test(message)
    || /maximum context length|prompt is too long|too many (input )?tokens/i.test(message);
  if (!says) return null;
  if (contextTokens === null) {
    const m = /(?:context (?:size|length|window)|n_ctx|num_ctx)[^0-9]{0,40}(\d{3,9})/i.exec(message) ?? /maximum[^0-9]{0,40}(\d{3,9}) tokens/i.exec(message);
    if (m) contextTokens = Number(m[1]);
  }
  if (requestTokens === null) {
    const m = /(?:request(?:ed)?|prompt|messages?|input)[^0-9]{0,40}(\d{3,9})(?: tokens)?/i.exec(message);
    if (m && Number(m[1]) !== contextTokens) requestTokens = Number(m[1]);
  }
  return { contextTokens, requestTokens };
}

/** The sentence a person reads: both sizes, and the two ways out. */
export function describeContextOverflow(model: string, contextTokens: number | null, requestTokens: number | null, exact = false): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const request = requestTokens ? `${exact ? '' : 'about '}${n(requestTokens)} tokens` : 'more tokens than fit';
  const context = contextTokens ? `${n(contextTokens)} tokens` : 'a smaller number';
  return `This request is ${request}, and the model ${model || 'in use'} can take in ${context} at once (its context size). `
    + 'Nothing was answered. Either raise the context size on the model server (in Ollama: num_ctx), '
    + 'or switch Josi to the compact prompt under Models, then send the message again.';
}

/** Status codes turned into something an operator can act on, with nothing of
 * the provider's own prose. */
export function describeFailure(status: number, category?: LlmErrorCategory): string {
  const cat = category ?? categorizeFailure(status);
  if (cat === 'unknown') return 'the model provider refused the request';
  return explainCategory(cat);
}

/** The provider's short error code, if it gave one that is safe to repeat.
 *
 * Safe means: an identifier, not a sentence. A code like `insufficient_quota`
 * carries no request content; a `message` very often quotes the prompt straight
 * back. So this reads `code` and `type`, refuses anything with whitespace, and
 * caps the length — a provider that puts prose in a code field gets ignored
 * rather than trusted. */
export const ALLOWANCE_EXHAUSTED = 'josi_allowance_exhausted';
const ALLOWANCE_FALLBACK = 'Your Hey Josi AI allowance is used up. Add a top-up on your account page, or wait for it to reset.';
function allowanceMessage(body: string): string {
  try {
    const text = (JSON.parse(body) as { error?: { message?: unknown } }).error?.message;
    return typeof text === 'string' && text.length <= 300 ? text : ALLOWANCE_FALLBACK;
  } catch { return ALLOWANCE_FALLBACK; }
}

export function safeErrorCode(body: string): string | undefined {
  let parsed: { error?: { code?: unknown; type?: unknown } };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    return undefined;
  }
  for (const candidate of [parsed.error?.code, parsed.error?.type]) {
    if (typeof candidate !== 'string') continue;
    if (!/^[a-z0-9_.:-]{1,64}$/i.test(candidate)) continue;
    return candidate;
  }
  return undefined;
}
