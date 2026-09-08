import { Router } from 'express';
import { requireAuth } from './authz.js';
import { asyncRoute } from './async.js';

const DOCS_URL = 'https://josi-ce-docs.netlify.app/';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 8;
const DOCS_CACHE_MS = 5 * 60_000;

interface HelpConfig {
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

function words(value: string): Set<string> {
  return new Set((value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])
    .map((word) => word.length > 4 && word.endsWith('s') ? word.slice(0, -1) : word));
}

/** Select only relevant public documentation. No workspace row, user content,
 * credential, or conversation is accepted by this boundary. */
function retrieve(html: string, question: string): string {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n').trim();
  const wanted = words(question);
  return text.split(/\n\s*\n/)
    .map((chunk) => ({ chunk: chunk.trim(), score: [...words(chunk)].filter((w) => wanted.has(w)).length }))
    .filter((entry) => entry.chunk.length > 40 && entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 6)
    .map((entry) => entry.chunk.slice(0, 1_500))
    .join('\n\n');
}

function relevantLink(question: string): string {
  const value = question.toLowerCase();
  if (/backup|restore|restic/.test(value)) return `${DOCS_URL}#backups`;
  if (/developer|github|netlify|vercel|supabase/.test(value)) return `${DOCS_URL}#developer-services`;
  if (/custom api|openapi/.test(value)) return `${DOCS_URL}#custom-api`;
  return DOCS_URL;
}

export function helpRoutes(cfg: HelpConfig = {}) {
  const r = Router();
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const now = cfg.now ?? Date.now;
  const usage = new Map<string, number[]>();
  let docsCache: { html: string; loadedAt: number } | undefined;

  r.use(requireAuth);
  r.get('/status', (_req, res) => res.json({ available: Boolean(cfg.apiKey) }));
  r.post('/ask', asyncRoute(async (req, res) => {
    if (!cfg.apiKey) {
      res.status(503).json({ error: 'Help chat is unavailable. You can still open the documentation.' });
      return;
    }
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question || question.length > 800) {
      res.status(400).json({ error: 'Ask a question between 1 and 800 characters.' });
      return;
    }

    const userId = req.user!.id;
    const cutoff = now() - WINDOW_MS;
    const recent = (usage.get(userId) ?? []).filter((stamp) => stamp > cutoff);
    if (recent.length >= MAX_PER_WINDOW) {
      res.status(429).json({ error: 'Help chat is busy. Wait a minute and try again.' });
      return;
    }
    recent.push(now()); usage.set(userId, recent);

    if (!docsCache || docsCache.loadedAt < now() - DOCS_CACHE_MS) {
      const docs = await fetchImpl(DOCS_URL, { headers: { Accept: 'text/html' } });
      if (!docs.ok) {
        res.status(503).json({ error: 'Help chat could not reach the documentation. Open the docs and try again later.' });
        return;
      }
      docsCache = { html: await docs.text(), loadedAt: now() };
    }
    const context = retrieve(docsCache.html, question);
    const link = relevantLink(question);
    if (!context) {
      res.json({ answer: 'I could not find that in the Josi CE documentation.', links: [link] });
      return;
    }

    const response = await fetchImpl(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'llama-3.1-8b-instant', temperature: 0, max_tokens: 500,
        messages: [
          { role: 'system', content: `Answer only from the supplied Josi CE documentation. If it does not answer the question, say so. Never invent steps.\n\nDOCUMENTATION:\n${context}` },
          { role: 'user', content: question },
        ],
      }),
    });
    if (!response.ok) {
      res.status(503).json({ error: 'Help chat is temporarily unavailable. You can still open the documentation.' });
      return;
    }
    const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const answer = payload.choices?.[0]?.message?.content?.trim();
    if (!answer) {
      res.status(503).json({ error: 'Help chat returned no answer. Open the documentation instead.' });
      return;
    }
    res.json({ answer, links: [link] });
  }));
  return r;
}
