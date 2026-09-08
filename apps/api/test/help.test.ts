import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { helpRoutes } from '../src/http/helpRoutes.js';

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>((resolve) => server!.close(() => resolve())); server = undefined; });

async function start(fetchImpl: typeof fetch, apiKey?: string) {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.user = { id: 'user-1', email: 'u@example.test', username: 'u', displayName: null, role: 'member', status: 'active' }; next(); });
  app.use('/help', helpRoutes({ fetchImpl, apiKey }));
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('documentation help chat', () => {
  it('has an honest unavailable state without a protected Groq key', async () => {
    const base = await start(async () => { throw new Error('must not fetch'); });
    expect(await (await fetch(`${base}/help/status`)).json()).toEqual({ available: false });
    const response = await fetch(`${base}/help/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How do backups work?' }) });
    expect(response.status).toBe(503);
  });

  it('sends only retrieved public documentation and the question to Groq', async () => {
    const calls: Array<{ url: string; body?: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input); calls.push({ url, body: init?.body as string | undefined });
      if (url.includes('josi-ce-docs')) return new Response('<h2>Backups</h2><p>Use Restic and verify a restore before relying on a backup.</p>');
      return Response.json({ choices: [{ message: { content: 'Use Restic and verify a restore. https://josi-ce-docs.netlify.app/' } }] });
    };
    const base = await start(fakeFetch as typeof fetch, 'test-key');
    const response = await fetch(`${base}/help/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How do backups work?' }) });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(2);
    const providerBody = calls[1].body ?? '';
    expect(providerBody).toContain('Use Restic');
    expect(providerBody).toContain('How do backups work?');
    expect(providerBody).not.toContain('user-1');
    expect(providerBody).not.toContain('u@example.test');
  });

  it('does not call the model when the docs contain no answer', async () => {
    let calls = 0;
    const base = await start((async () => { calls += 1; return new Response('<p>Welcome to Josi CE documentation.</p>'); }) as typeof fetch, 'test-key');
    const response = await fetch(`${base}/help/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How do I breed dragons?' }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.answer).toMatch(/could not find/i);
    expect(body.links).toEqual(['https://josi-ce-docs.netlify.app/']);
    expect(calls).toBe(1);
  });
});
