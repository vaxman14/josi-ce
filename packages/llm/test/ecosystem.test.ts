import { describe, expect, it } from 'vitest';
import { PROVIDER_CATALOG } from '../src/catalog.js';
import { cohereProvider } from '../src/providers/cohere.js';
import { geminiProvider } from '../src/providers/gemini.js';

describe('broader provider ecosystem', () => {
  it('has unique provider ids and honest transport metadata', () => {
    expect(new Set(PROVIDER_CATALOG.map((provider) => provider.id)).size).toBe(PROVIDER_CATALOG.length);
    expect(PROVIDER_CATALOG.find((provider) => provider.id === 'aws_bedrock')?.transport).toBe('custom_endpoint');
    expect(PROVIDER_CATALOG.find((provider) => provider.id === 'gemini')?.transport).toBe('gemini');
  });

  it('translates a Gemini chat and tool call', async () => {
    let request: { url?: string; body?: Record<string, unknown>; key?: string } = {};
    const provider = geminiProvider({ model: 'gemini-test', apiKey: 'hidden', fetchImpl: async (input, init) => {
      request = { url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown>, key: new Headers(init?.headers).get('x-goog-api-key') ?? undefined };
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hello' }, { functionCall: { name: 'remember', args: { value: 1 } } }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2 } }));
    }});
    const response = await provider.chat({ system: 'safe', messages: [{ role: 'user', content: 'hi' }], tools: [{ name: 'remember', description: 'remember', parameters: { type: 'object' } }] });
    expect(request.url).toContain('/models/gemini-test:generateContent');
    expect(request.key).toBe('hidden');
    expect(response.text).toBe('hello');
    expect(response.toolCalls[0]).toMatchObject({ name: 'remember', input: { value: 1 } });
  });

  it('translates Cohere Chat v2', async () => {
    const provider = cohereProvider({ model: 'command-test', apiKey: 'hidden', fetchImpl: async () => new Response(JSON.stringify({ message: { content: [{ type: 'text', text: 'hello' }] }, usage: { billed_units: { input_tokens: 4, output_tokens: 1 } } })) });
    const response = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] });
    expect(response.text).toBe('hello');
    expect(response.usage).toEqual({ inputTokens: 4, outputTokens: 1 });
  });
});
