import { LlmError, categorizeFailure, explainCategory, type ChatRequest, type ChatResponse, type LlmProvider, type ToolCall } from '../types.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from '../ssrf.js';

export interface GeminiOptions {
  model: string; apiKey?: string | null; timeoutMs?: number; fetchImpl?: typeof fetch;
  resolve?: SafeFetchOptions['resolve']; baseUrl?: string | null;
}

export function geminiProvider(opts: GeminiOptions): LlmProvider {
  const base = (opts.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
  return { kind: 'gemini', model: opts.model, external: true, async chat(request): Promise<ChatResponse> {
    const contents: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      const parts: Array<Record<string, unknown>> = [];
      if (message.content) parts.push({ text: message.content });
      for (const image of message.images ?? []) parts.push({ inlineData: { mimeType: image.mediaType, data: image.base64 } });
      for (const call of message.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.input } });
      for (const result of message.toolResults ?? []) parts.push({ functionResponse: { name: result.name, response: safeJson(result.content) } });
      if (parts.length) contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts });
    }
    const body: Record<string, unknown> = { contents, generationConfig: { maxOutputTokens: request.maxTokens ?? 1024, ...(request.temperature === undefined ? {} : { temperature: request.temperature }), ...(request.jsonMode ? { responseMimeType: 'application/json' } : {}) } };
    if (request.system) body.systemInstruction = { parts: [{ text: request.system }] };
    if (request.tools?.length) body.tools = [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }];
    const started = Date.now();
    let response: Response;
    try { response = await safeFetch(`${base}/models/${encodeURIComponent(opts.model)}:generateContent`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { 'x-goog-api-key': opts.apiKey } : {}) }, body: JSON.stringify(body) }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve }); }
    catch (error) { if (error instanceof UnsafeEndpointError) throw new LlmError(error.message, { needsReconfiguration: true }); throw new LlmError(explainCategory('network'), { category: 'network', retryable: true }); }
    const raw = await response.text().catch(() => '');
    if (!response.ok) { const category = categorizeFailure(response.status); throw new LlmError(explainCategory(category), { status: response.status, category, needsReconfiguration: [401,403].includes(response.status), retryable: response.status === 429 || response.status >= 500 }); }
    let parsed: { candidates?: Array<{ content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: Record<string, unknown> } }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw new LlmError('the model endpoint returned something that is not valid JSON'); }
    const parts = parsed.candidates?.[0]?.content?.parts ?? [];
    const toolCalls: ToolCall[] = parts.flatMap((part, index) => part.functionCall?.name ? [{ id: `gemini_${index}`, name: part.functionCall.name, input: part.functionCall.args ?? {} }] : []);
    return { text: parts.map((part) => part.text ?? '').join(''), toolCalls, usage: { inputTokens: parsed.usageMetadata?.promptTokenCount ?? 0, outputTokens: parsed.usageMetadata?.candidatesTokenCount ?? 0 }, latencyMs: Date.now() - started };
  } };
}

function safeJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { return { result: value }; } }
