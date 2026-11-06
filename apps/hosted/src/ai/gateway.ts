// The AI gateway: OpenAI's wire format in and out, on the owner's OpenAI key.
//
// Nothing a person writes is stored or logged here. Token counts and cost are all
// that survive a call. Fields are allowed by name, because each one OpenAI adds
// could carry a cost the reservation doesn't bound.
import { once } from 'node:events';
import express, { type Request, type Response, type Router } from 'express';
import type { Ctx } from '../context.js';
import { sha256 } from '../crypto.js';
import { aiPool, type Pool } from '../plans.js';
import { chargeMicros, enabledModels, reserve, settle, type ModelRow, type Outcome } from './allowance.js';

/** Covers what OpenAI wraps around a request: message framing and the tool
 * preamble. The JSON punctuation in the body already outweighs most of it. */
const INPUT_OVERHEAD_TOKENS = 512;

const ALLOWED_FIELDS = new Set(['model', 'messages', 'max_tokens', 'max_completion_tokens', 'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'stop', 'stream', 'stream_options', 'n',
  'tools', 'tool_choice', 'parallel_tool_calls', 'functions', 'function_call', 'response_format', 'seed', 'user', 'safety_identifier', 'prompt_cache_key', 'logit_bias', 'logprobs', 'top_logprobs',
  'reasoning_effort', 'verbosity', 'store']);
const MESSAGE_FIELDS = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'function_call', 'refusal']);
const ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool', 'function']);
// Audio and files are refused: their token counts have nothing to do with their
// size in the body, so no honest bound exists for them.
const PART_TYPES = new Set(['text', 'image_url', 'refusal']);
const TOOL_TYPES = new Set(['function', 'custom']);

class BadRequest extends Error {}

function fail(res: Response, status: number, type: string, code: string, message: string): void {
  res.status(status).set('cache-control', 'no-store').json({ error: { type, code, message } });
}

interface Caller { serverId: string; accountId: string; pool: Pool | null }

async function callerOf(ctx: Ctx, req: Request): Promise<Omit<Caller, 'pool'> | null> {
  const header = req.get('authorization') ?? '';
  if (!header.startsWith('Bearer ')) return null;
  const [row] = await ctx.db.query<{ id: string; account_id: string }>('select id, account_id from heyjosi.servers where ai_token_hash = $1', [sha256(header.slice(7).trim())]);
  return row ? { serverId: row.id, accountId: row.account_id } : null;
}

async function authorize(ctx: Ctx, req: Request, res: Response): Promise<Caller | null> {
  const caller = await callerOf(ctx, req);
  if (!caller) { fail(res, 401, 'invalid_request_error', 'invalid_api_key', 'That AI token isn\'t valid. Sync your Josi server with your account, or reset the token on your account page.'); return null; }
  const pool = await aiPool(ctx, caller.accountId);
  if (!pool) { fail(res, 402, 'plan_required', 'josi_plan_required', 'This account doesn\'t have Hey Josi AI right now. Check your plan and payment on your account page.'); return null; }
  return { ...caller, pool };
}

interface Prepared { outgoing: Record<string, unknown>; stream: boolean; wantsUsage: boolean; images: number; maxOutput: number }

function outputCeiling(ctx: Ctx, body: Record<string, unknown>): number {
  const asked = body.max_completion_tokens ?? body.max_tokens;
  if (asked === undefined || asked === null) return ctx.config.ai.maxOutputTokens;
  if (!Number.isInteger(asked) || (asked as number) < 1) throw new BadRequest('max_tokens must be a positive whole number.');
  return Math.min(asked as number, ctx.config.ai.maxOutputTokens);
}

function countImages(messages: unknown[]): number {
  let images = 0;
  for (const message of messages) {
    if (!message || typeof message !== 'object') throw new BadRequest('Each message must be an object.');
    const fields = message as Record<string, unknown>;
    for (const key of Object.keys(fields)) if (!MESSAGE_FIELDS.has(key)) throw new BadRequest(`Messages can't carry "${key}" here.`);
    if (!ROLES.has(String(fields.role))) throw new BadRequest('A message has a role this gateway doesn\'t know.');
    if (!Array.isArray(fields.content)) {
      if (fields.content !== null && fields.content !== undefined && typeof fields.content !== 'string') throw new BadRequest('Message content must be text or a list of parts.');
      continue;
    }
    for (const part of fields.content as Array<Record<string, unknown>>) {
      if (!PART_TYPES.has(String(part?.type))) throw new BadRequest(`This gateway takes text and images only, not "${String(part?.type)}".`);
      // Every image counts, inline ones too: a small compressed file can still be
      // a very large picture, so its bytes say nothing about its tokens.
      if (part.type === 'image_url') images++;
    }
  }
  return images;
}

function prepare(ctx: Ctx, body: Record<string, unknown>): Prepared {
  for (const key of Object.keys(body)) if (!ALLOWED_FIELDS.has(key)) throw new BadRequest(`"${key}" isn't supported by this gateway, because its cost can't be bounded in advance.`);
  if (!Array.isArray(body.messages) || !body.messages.length) throw new BadRequest('messages must be a list with at least one message.');
  if (body.n !== undefined && body.n !== null && body.n !== 1) throw new BadRequest('This gateway returns one answer per call, so n must be 1.');
  if (body.store === true) throw new BadRequest('Storing conversations at OpenAI isn\'t available here.');
  const tools = body.tools;
  if (tools !== undefined && (!Array.isArray(tools) || tools.some(tool => !TOOL_TYPES.has(String((tool as { type?: unknown })?.type))))) throw new BadRequest('Only function tools are supported here.');
  const images = countImages(body.messages);
  const maxOutput = outputCeiling(ctx, body);
  const stream = body.stream === true;
  const wantsUsage = (body.stream_options as { include_usage?: unknown } | undefined)?.include_usage === true;
  const { max_tokens: _old, stream_options: _options, ...rest } = body;
  const outgoing: Record<string, unknown> = { ...rest, max_completion_tokens: maxOutput, store: false };
  if (stream) outgoing.stream_options = { include_usage: true };
  return { outgoing, stream, wantsUsage, images, maxOutput };
}

interface Usage { inputTokens: number; outputTokens: number }

function readUsage(value: unknown): Usage | null {
  const usage = value as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined;
  const input = usage?.prompt_tokens, output = usage?.completion_tokens;
  return Number.isInteger(input) && Number.isInteger(output) && (input as number) >= 0 && (output as number) >= 0 ? { inputTokens: input as number, outputTokens: output as number } : null;
}

const settled = (model: ModelRow, usage: Usage | null): Outcome => usage ? { kind: 'settled', model, ...usage } : { kind: 'unknown' };

/** Only a failure to connect proves OpenAI never saw the call. */
function neverSent(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(code ?? '');
}

/** OpenAI's words go back only for a bad request, where they help and describe
 * the caller's own mistake. Other errors can name the owner's organization. */
async function relayError(res: Response, upstream: globalThis.Response): Promise<void> {
  const body = await upstream.json().catch(() => null) as { error?: { message?: unknown; code?: unknown } } | null;
  if (upstream.status === 400) { fail(res, 400, 'invalid_request_error', String(body?.error?.code ?? 'upstream_rejected'), String(body?.error?.message ?? 'OpenAI turned that request down.')); return; }
  if (upstream.status === 429) { fail(res, 429, 'rate_limit_error', 'josi_upstream_busy', 'OpenAI is busy right now. Try again in a moment. This call wasn\'t charged.'); return; }
  fail(res, 502, 'upstream_error', 'josi_upstream_error', 'OpenAI couldn\'t answer that. Try again in a moment. This call wasn\'t charged.');
}

/** Passes server-sent events through, watching for the usage chunk. Whole events
 * only, so a chunk can be dropped for a client that didn't ask for it: some
 * clients read `choices[0]` of every chunk, and that one has no choices. */
class EventSieve {
  usage: Usage | null = null;
  private pending = '';
  private readonly decoder = new TextDecoder();
  constructor(private readonly wantsUsage: boolean) {}

  push(bytes: Uint8Array | null): string {
    this.pending += bytes ? this.decoder.decode(bytes, { stream: true }) : this.decoder.decode();
    let out = '';
    for (;;) {
      const match = /\r?\n\r?\n/.exec(this.pending);
      if (!match) break;
      const event = this.pending.slice(0, match.index + match[0].length);
      this.pending = this.pending.slice(match.index + match[0].length);
      if (this.keep(event)) out += event;
    }
    if (!bytes) { out += this.pending; this.pending = ''; }
    return out;
  }

  private keep(event: string): boolean {
    const data = /^data:\s*(.*)$/m.exec(event)?.[1];
    if (!data || data.trim() === '[DONE]') return true;
    let chunk: { usage?: unknown; choices?: unknown[] };
    try { chunk = JSON.parse(data) as typeof chunk; } catch { return true; }
    const usage = readUsage(chunk.usage);
    if (!usage) return true;
    this.usage = usage;
    return this.wantsUsage || !!chunk.choices?.length;
  }
}

async function send(res: Response, text: string): Promise<void> {
  if (!text || res.destroyed) return;
  if (!res.write(text)) await Promise.race([once(res, 'drain'), once(res, 'close')]);
}

async function chat(ctx: Ctx, req: Request, res: Response): Promise<void> {
  const caller = await authorize(ctx, req, res);
  if (!caller) return;
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
  } catch { fail(res, 400, 'invalid_request_error', 'invalid_json', 'The request body must be a JSON object.'); return; }

  let prepared: Prepared;
  try { prepared = prepare(ctx, body); } catch (error) {
    if (!(error instanceof BadRequest)) throw error;
    fail(res, 400, 'invalid_request_error', 'unsupported_request', error.message);
    return;
  }

  const models = await ctx.db.query<ModelRow>('select * from heyjosi.models');
  const named = typeof body.model === 'string' && body.model ? body.model : null;
  const model = named ? models.find(row => row.id === named) : models.find(row => row.is_default);
  if (!model) { fail(res, 400, 'invalid_request_error', 'model_not_found', `There's no model called "${named ?? 'default'}" here. GET /ai/v1/models lists what's available.`); return; }
  if (!model.enabled || !model.upstream_id) { fail(res, 400, 'invalid_request_error', 'model_not_available', `${model.label} isn't available yet. Pick another model; GET /ai/v1/models lists them.`); return; }

  // The body's size bounds its tokens, since a token is at least one byte.
  const inputBound = raw.length + prepared.images * ctx.config.ai.imageTokens + INPUT_OVERHEAD_TOKENS;
  const amount = Math.max(1, chargeMicros(model, inputBound, prepared.maxOutput));
  const reservation = await reserve(ctx, { pool: caller.pool!, accountId: caller.accountId, serverId: caller.serverId, model, amount });
  if (!reservation.ok) { fail(res, 402, 'allowance_exhausted', 'josi_allowance_exhausted', reservation.message); return; }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ctx.config.ai.upstreamTimeoutMs);
  res.once('close', () => { if (!res.writableFinished) controller.abort(); });
  // Starts as "we don't know", so any path that fails to decide charges in full.
  let outcome: Outcome = { kind: 'unknown' };
  try {
    let upstream: globalThis.Response;
    try {
      upstream = await ctx.fetch(`${ctx.config.openai.baseUrl}/chat/completions`, {
        method: 'POST', signal: controller.signal,
        headers: { authorization: `Bearer ${ctx.config.openai.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ ...prepared.outgoing, model: model.upstream_id }),
      });
    } catch (error) {
      if (neverSent(error)) outcome = { kind: 'released' };
      ctx.log('ai_upstream_failed', { model: model.id, sent: outcome.kind === 'unknown' });
      await settle(ctx, reservation.id, outcome);
      if (!res.destroyed) fail(res, 502, 'upstream_error', 'josi_upstream_error', 'OpenAI couldn\'t be reached. Try again in a moment.');
      return;
    }
    if (!upstream.ok) {
      outcome = { kind: 'released' };
      ctx.log('ai_upstream_refused', { model: model.id, status: upstream.status });
      // Before answering, so a retry right after this doesn't find the room taken.
      await settle(ctx, reservation.id, outcome);
      await relayError(res, upstream);
      return;
    }
    if (!prepared.stream || !upstream.body) {
      const text = await upstream.text();
      let usage: Usage | null = null;
      try { usage = readUsage((JSON.parse(text) as { usage?: unknown }).usage); } catch { /* charged in full below */ }
      outcome = settled(model, usage);
      await settle(ctx, reservation.id, outcome);
      res.status(200).type('application/json').set('cache-control', 'no-store').send(text);
      return;
    }
    res.status(200).set({ 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    const sieve = new EventSieve(prepared.wantsUsage);
    const reader = upstream.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await send(res, sieve.push(value));
        if (res.destroyed) break;
      }
      await send(res, sieve.push(null));
    } catch { ctx.log('ai_stream_cut', { model: model.id }); }
    outcome = settled(model, sieve.usage);
    await settle(ctx, reservation.id, outcome);
    if (!res.destroyed) res.end();
  } finally {
    clearTimeout(timeout);
    // Already closed on the normal paths, and then this does nothing. If the
    // database is the problem, the sweep charges it in full later.
    await settle(ctx, reservation.id, outcome).catch(() => ctx.log('ai_settle_failed', { model: model.id }));
  }
}

export function aiRouter(ctx: Ctx): Router {
  const router = express.Router();
  router.get('/models', async (req, res) => {
    if (!await authorize(ctx, req, res)) return;
    const models = await enabledModels(ctx);
    res.set('cache-control', 'no-store').json({ object: 'list', data: models.map(model => ({ id: model.id, object: 'model', created: 0, owned_by: 'josi' })) });
  });
  router.post('/chat/completions', express.raw({ type: () => true, limit: ctx.config.ai.maxBodyBytes }), (req, res) => chat(ctx, req, res));
  return router;
}
