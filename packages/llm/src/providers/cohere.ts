import { LlmError, categorizeFailure, explainCategory, type ChatResponse, type LlmProvider, type ToolCall } from '../types.js';
import { safeFetch, UnsafeEndpointError, type SafeFetchOptions } from '../ssrf.js';

export interface CohereOptions { model: string; apiKey?: string | null; timeoutMs?: number; fetchImpl?: typeof fetch; resolve?: SafeFetchOptions['resolve']; baseUrl?: string | null }

export function cohereProvider(opts: CohereOptions): LlmProvider {
  const base = (opts.baseUrl || 'https://api.cohere.com/v2').replace(/\/$/, '');
  return { kind: 'cohere', model: opts.model, external: true, async chat(request): Promise<ChatResponse> {
    const messages: Array<Record<string, unknown>> = [];
    for (const message of request.messages) {
      if (message.toolResults?.length) {
        messages.push(...message.toolResults.map((result) => ({ role: 'tool', tool_call_id: result.toolCallId, content: result.content })));
      } else {
        messages.push({ role: message.role, content: message.content, ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.input) } })) } : {}) });
      }
    }
    if (request.system) messages.unshift({ role: 'system', content: request.system });
    const body: Record<string, unknown> = { model: opts.model, messages, max_tokens: request.maxTokens ?? 1024 };
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.tools?.length) body.tools = request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    const started = Date.now(); let response: Response;
    try { response = await safeFetch(`${base}/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}) }, body: JSON.stringify(body) }, { timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl, resolve: opts.resolve }); }
    catch (error) { if (error instanceof UnsafeEndpointError) throw new LlmError(error.message, { needsReconfiguration: true }); throw new LlmError(explainCategory('network'), { category: 'network', retryable: true }); }
    const raw = await response.text().catch(() => '');
    if (!response.ok) { const category = categorizeFailure(response.status); throw new LlmError(explainCategory(category), { status: response.status, category, needsReconfiguration: [401,403].includes(response.status), retryable: response.status === 429 || response.status >= 500 }); }
    let parsed: { message?: { content?: Array<{ type?: string; text?: string }>; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> }; usage?: { billed_units?: { input_tokens?: number; output_tokens?: number } } };
    try { parsed = JSON.parse(raw) as typeof parsed; } catch { throw new LlmError('the model endpoint returned something that is not valid JSON'); }
    const toolCalls: ToolCall[] = (parsed.message?.tool_calls ?? []).map((call, index) => ({ id: call.id ?? `cohere_${index}`, name: call.function?.name ?? '', input: parseArgs(call.function?.arguments) }));
    return { text: (parsed.message?.content ?? []).map((part) => part.text ?? '').join(''), toolCalls, usage: { inputTokens: parsed.usage?.billed_units?.input_tokens ?? 0, outputTokens: parsed.usage?.billed_units?.output_tokens ?? 0 }, latencyMs: Date.now() - started };
  } };
}
function parseArgs(value?: string): Record<string, unknown> { try { return value ? JSON.parse(value) as Record<string, unknown> : {}; } catch { return {}; } }
