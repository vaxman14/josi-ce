// What a person sees when the Hey Josi allowance runs out.
import { describe, expect, it } from 'vitest';
import { openAiCompatibleProvider } from '../src/providers/openaiCompatible.js';
import { describeProvider, LlmError } from '../src/index.js';

const SENTENCE = 'Your AI allowance is used up. Add a top-up on your account page.';

describe('the Hey Josi provider', () => {
  it('counts as leaving the server, so Local-only refuses it', () => {
    expect(describeProvider('hey_josi')).toMatchObject({ external: true, wire: 'openai-chat' });
  });

  it('stops cleanly at the cap and says why, with no retry and no failover', async () => {
    const provider = openAiCompatibleProvider({
      kind: 'hey_josi', baseUrl: 'https://hosted.test/ai/v1', apiKey: 'token', model: 'gpt-5.6-luna',
      fetchImpl: (async () => new Response(JSON.stringify({ error: { type: 'allowance_exhausted', code: 'josi_allowance_exhausted', message: SENTENCE } }), { status: 402 })) as unknown as typeof fetch,
      resolve: async () => ['93.184.216.34'],
    } as never);
    const failure = await provider.chat({ messages: [{ role: 'user', content: 'hi' }] }).catch(error => error as LlmError);
    expect(failure).toBeInstanceOf(LlmError);
    expect((failure as LlmError).message).toBe(SENTENCE);
    expect(failure).toMatchObject({ category: 'billing', retryable: false });
  });
});
