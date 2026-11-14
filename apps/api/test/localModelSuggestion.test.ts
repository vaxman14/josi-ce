import { afterEach, describe, expect, it } from 'vitest';
import { localModelSuggestion } from '../src/setup/setupRoutes.js';

const tags = (models: unknown, status = 200) => (async () => new Response(JSON.stringify({ models }), { status })) as unknown as typeof fetch;
afterEach(() => { delete process.env.JOSI_LINUX_SERVER; });

describe('the model server found on this machine', () => {
  it('is only looked for on the Linux server', async () => {
    expect(await localModelSuggestion(tags([{ name: 'josi-qwen3.5-9b:latest' }]))).toBeNull();
  });
  it('suggests the Josi model, without ":latest", on the loopback address', async () => {
    process.env.JOSI_LINUX_SERVER = '1';
    expect(await localModelSuggestion(tags([{ name: 'llama3:8b' }, { name: 'josi-qwen3.5-9b:latest' }])))
      .toEqual({ baseUrl: 'http://127.0.0.1:11434/v1', model: 'josi-qwen3.5-9b' });
  });
  it('falls back to the first model, and to nothing when there is none or the server is down', async () => {
    process.env.JOSI_LINUX_SERVER = '1';
    expect(await localModelSuggestion(tags([{ name: 'llama3:8b' }]))).toMatchObject({ model: 'llama3:8b' });
    expect(await localModelSuggestion(tags([]))).toBeNull();
    expect(await localModelSuggestion(tags([{ name: 5 }, {}]))).toBeNull();
    expect(await localModelSuggestion(tags([{ name: 'x' }], 500))).toBeNull();
    expect(await localModelSuggestion((async () => { throw new Error('refused'); }) as unknown as typeof fetch)).toBeNull();
  });
});
