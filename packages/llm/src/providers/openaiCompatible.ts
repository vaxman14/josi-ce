// OpenAI's chat-completions shape, which OpenAI, xAI and essentially every
// self-hosted runtime speak. One adapter, three providers, because the wire
// format is the same and pretending otherwise would mean three copies of the
// same bugs.
import {
  LlmError, categorizeFailure, explainCategory,
  type ChatRequest, type ChatResponse, type LlmErrorCategory, type LlmProvider, type ProviderKind, type ToolCall,
} from '../types.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from '../ssrf.js';

const DEFAULT_BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  xai: 'https://api.x.ai/v1',
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  mistral: 'https://api.mistral.ai/v1',
  kimi: 'https://api.moonshot.ai/v1',
  zhipu: 'https://open.bigmodel.cn/api/paas/v4',
  openrouter: 'https://openrouter.ai/api/v1',
  minimax: 'https://api.minimax.io/v1',
};

export interface OpenAiCompatibleOptions {
  kind: ProviderKind;
  model: string;
  apiKey?: string | null;
  /** Required for `openai_compatible`; ignored for the hosted providers, which
   * have one endpoint each. */
  baseUrl?: string | null;
  external: boolean;
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

export function openAiCompatibleProvider(opts: OpenAiCompatibleOptions): LlmProvider {
  const base = (opts.baseUrl || DEFAULT_BASE[opts.kind] || '').replace(/\/$/, '');
  if (!base) throw new LlmError(`no endpoint configured for ${opts.kind}`);

  return {
    kind: opts.kind,
    model: opts.model,
    external: opts.external,

    async chat(request: ChatRequest): Promise<ChatResponse> {
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
        messages.push({ role: m.role, content: m.content });
      }

      const body: Record<string, unknown> = {
        model: opts.model,
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

      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      // A self-hosted runtime may need no key at all; sending an empty bearer
      // makes some of them reject the request outright.
      if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

      const started = Date.now();
      let res: Response;
      try {
        res = await safeFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve });
      } catch (err) {
        if (err instanceof UnsafeEndpointError) {
          throw new LlmError(err.message, { needsReconfiguration: true });
        }
        // Abort or socket failure.
        throw new LlmError(explainCategory('network'), { retryable: true, category: 'network' });
      }
      const latencyMs = Date.now() - started;

      const text = await res.text().catch(() => '');
      if (!res.ok) {
        // The provider's own PROSE goes nowhere near the caller: it routinely
        // echoes back parts of the request, and this one contains the prompt.
        // Its short `code`/`type` is an enum member rather than prose, and it
        // is the only thing that distinguishes "slow down" from "out of
        // credit" — both of which arrive as 429.
        const providerCode = safeErrorCode(text);
        const category = categorizeFailure(res.status, providerCode);
        throw new LlmError(describeFailure(res.status, category), {
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
    },
  };
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
