// How big a request is, in tokens, and where the size comes from.
//
// There is no tokenizer here on purpose: every model family counts differently
// and shipping one per family is not worth it for a number whose job is "will
// this fit, and which part is the heavy one". The estimate is characters
// divided by a ratio measured against real requests (prose about 4 characters
// per token, tool schemas nearer 3.4 because JSON punctuation is dense). When
// a provider reports what it actually counted, `calibrate` scales the parts to
// that total, so the split shown to the operator adds up to the real number.
import type { ChatMessage, ChatRequest } from './types.js';

export interface PromptSize {
  /** The system prompt. */
  system: number;
  /** Tool names, descriptions and argument schemas. */
  tools: number;
  /** Earlier messages in the conversation, tool results included. */
  history: number;
  /** The message being answered, with any attached text. */
  latest: number;
  total: number;
  /** True when `total` is the provider's own count rather than the estimate. */
  measured: boolean;
}

const PROSE_CHARS_PER_TOKEN = 4;
const JSON_CHARS_PER_TOKEN = 3.4;

export function estimateTokens(text: string, json = false): number {
  if (!text) return 0;
  return Math.ceil(text.length / (json ? JSON_CHARS_PER_TOKEN : PROSE_CHARS_PER_TOKEN));
}

function messageTokens(message: ChatMessage): number {
  let n = estimateTokens(message.content) + 4;
  for (const call of message.toolCalls ?? []) n += estimateTokens(call.name + JSON.stringify(call.input), true) + 8;
  for (const result of message.toolResults ?? []) n += estimateTokens(result.content, true) + 8;
  return n;
}

/** The size of one request, split by where it comes from. An estimate. */
export function measureRequest(request: Pick<ChatRequest, 'system' | 'tools' | 'messages'>): PromptSize {
  const system = estimateTokens(request.system ?? '');
  const tools = request.tools?.length
    ? estimateTokens(JSON.stringify(request.tools.map((t) => ({ type: 'function', function: t }))), true)
    : 0;
  const messages = request.messages;
  // The latest message is the last one a person wrote. Everything after it in
  // the same turn (tool calls and their results) is counted as history, which
  // is what it is to the model.
  let lastUser = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && !messages[i].toolResults?.length) { lastUser = i; break; }
  }
  let history = 0;
  let latest = 0;
  messages.forEach((message, i) => { if (i === lastUser) latest += messageTokens(message); else history += messageTokens(message); });
  return { system, tools, history, latest, total: system + tools + history + latest, measured: false };
}

/** Scale an estimate to the provider's own count, keeping the proportions. */
export function calibrate(size: PromptSize, reportedInputTokens: number | undefined): PromptSize {
  if (!reportedInputTokens || reportedInputTokens <= 0 || !size.total) return size;
  const k = reportedInputTokens / size.total;
  const system = Math.round(size.system * k);
  const tools = Math.round(size.tools * k);
  const history = Math.round(size.history * k);
  return { system, tools, history, latest: Math.max(0, reportedInputTokens - system - tools - history), total: reportedInputTokens, measured: true };
}

/** One line for a log or a status screen. */
export function describePromptSize(size: PromptSize): string {
  const n = (v: number) => v.toLocaleString('en-US');
  return `${size.measured ? '' : 'about '}${n(size.total)} tokens (system ${n(size.system)}, tools ${n(size.tools)}, history ${n(size.history)}, this message ${n(size.latest)})`;
}
