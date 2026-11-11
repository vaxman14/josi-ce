// The one place an outside MCP server is actually contacted.
//
// An MCP server is a web address that offers an assistant a list of tools.
// This file speaks the "Streamable HTTP" form of that protocol and nothing
// else: one JSON-RPC message per POST, answered either as JSON or as a short
// event stream. There is no stdio transport here and nothing in this file can
// start a program.
//
// The rules, each one written as code so a test can attack it directly:
//
//   * HTTPS, PUBLIC ADDRESSES ONLY, CHECKED ON EVERY REQUEST. The address comes
//     from a form a person filled in (and, for OAuth, from documents the server
//     itself published), so every request re-resolves the host and refuses
//     loopback, private, link-local, CGNAT, multicast and unique-local
//     addresses. `assertPublicHost` is the same guard Custom APIs use.
//   * REDIRECTS ARE AN ERROR. Checking an address and then following a 302
//     somewhere else checks the wrong address.
//   * EVERYTHING IS BOUNDED: a timeout, a ceiling on bytes read, on tools kept,
//     on description length, on schema size, on result length.
//   * EVERYTHING THE SERVER SAYS IS UNTRUSTED. Tool names, descriptions and
//     results are cleaned and clipped here. A server's error text never
//     reaches a log, an audit record or a stored column.
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { ConnectorError, type ErrorCategory } from './providers.js';
import { assertPublicHost, pinnedLookup } from './customApiRequest.js';

/** A refusal from this layer: a category the UI can say in plain words and a
 * sentence Josi wrote. */
export class McpError extends ConnectorError {
  /** The server answered 401: the sign-in is missing, wrong or run out. */
  unauthorized = false;
  /** The 401's WWW-Authenticate header, which says where sign-in lives. It is
   * a pointer, not a secret. */
  wwwAuthenticate: string | null = null;
  /** A JSON-RPC error the server sent for this one request. */
  rpcCode: number | null = null;
  /** The server's own words about that error, cleaned and clipped. For the
   * person or the assistant only; never for a log. */
  serverSaid: string | null = null;

  constructor(
    message: string,
    init: Partial<Pick<McpError, 'category' | 'status' | 'unauthorized' | 'wwwAuthenticate' | 'rpcCode' | 'serverSaid'>> = {},
  ) {
    super(message, { category: init.category, status: init.status });
    Object.assign(this, init);
  }
}

export interface McpNetOptions {
  /** Injected by the tests, so no suite contacts a real server. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests to answer with a hostile address. */
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 20_000;
/** The most of any one answer Josi will read. */
export const MCP_MAX_RESPONSE_BYTES = 1024 * 1024;
/** Tools kept per server. A server offering more has the rest left out, and
 * the settings page says how many. */
export const MCP_MAX_TOOLS = 100;
const MAX_TOOL_PAGES = 10;
export const MCP_MAX_DESCRIPTION_CHARS = 300;
/** A tool whose input description is larger than this is left out. */
export const MCP_MAX_SCHEMA_BYTES = 8 * 1024;
/** The most of a tool's answer that goes back to the assistant. */
export const MCP_MAX_RESULT_CHARS = 20_000;
/** The largest set of arguments Josi will send to a tool. */
export const MCP_MAX_ARGUMENT_BYTES = 64 * 1024;
const MAX_TOOL_NAME_CHARS = 128;

// ------------------------------------------------------------- cleaning

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g;

/** One line of text from an outside server: no control or direction-changing
 * characters, single spaces, clipped. */
export function cleanMcpLine(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const text = raw.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Longer text (a tool's answer): control characters removed, line breaks
 * kept. Clipping is the caller's, because the caller says so when it does. */
export function cleanMcpText(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(CONTROL, ' ') : '';
}

/** A tool name in the only alphabet a model-facing tool name may use. */
export function mcpSafeName(raw: string): string {
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_{3,}/g, '__').slice(0, 64);
  return safe || 'tool';
}

function cleanSchema(value: unknown, depth = 0): unknown {
  if (depth > 10) return {};
  if (typeof value === 'string') return cleanMcpLine(value, MCP_MAX_DESCRIPTION_CHARS);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => cleanSchema(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 200)) {
      const name = cleanMcpLine(key, 100);
      if (!name || name === '__proto__' || name === 'constructor' || name === 'prototype') continue;
      out[name] = cleanSchema(item, depth + 1);
    }
    return out;
  }
  return null;
}

// ------------------------------------------------------------- transport

function parseTarget(raw: string): { url: URL; host: string } {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new McpError('that is not a valid web address', { category: 'provider_error' });
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new McpError('Josi only contacts outside servers over https, without a password in the address', { category: 'provider_error' });
  }
  return { url, host: url.hostname.toLowerCase().replace(/^\[|\]$/g, '') };
}

/** Resolves the host and refuses anything that is not on the public internet.
 * Exported so the guard can be tested on its own. */
export async function assertPublicMcpHost(host: string, opts: McpNetOptions = {}): Promise<string[]> {
  try {
    return await assertPublicHost(host, { resolve: opts.resolve });
  } catch {
    throw new McpError(
      `${host} is not reachable on the public internet from this server, so Josi refused to contact it. `
      + 'An MCP server must have a public address.',
      { category: 'network' },
    );
  }
}

interface Opened { res: Response; host: string; finish: () => Promise<void> }

/** One request to one outside address: guarded, timed, never redirected. The
 * caller reads the body and then calls `finish`. Used for MCP itself and for
 * every OAuth endpoint. */
export async function mcpOpen(
  rawUrl: string,
  init: { method: string; headers: Record<string, string>; body?: string },
  opts: McpNetOptions = {},
): Promise<Opened> {
  const { url, host } = parseTarget(rawUrl);
  const approved = await assertPublicMcpHost(host, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  // Production pins the socket to an address that passed the check above, so a
  // second DNS answer cannot move the request somewhere else.
  const dispatcher = opts.fetchImpl ? undefined : new Agent({
    connect: { lookup: pinnedLookup(approved) },
  });
  const finish = async () => {
    clearTimeout(timer);
    await dispatcher?.close().catch(() => undefined);
  };
  try {
    const request = { method: init.method, headers: init.headers, body: init.body, redirect: 'error', signal: controller.signal } as const;
    const res = opts.fetchImpl
      ? await opts.fetchImpl(url.toString(), request)
      : await undiciFetch(url.toString(), { ...request, dispatcher }) as unknown as Response;
    // An injected fetch may hand back a redirect instead of throwing.
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined);
      await finish();
      throw new McpError(`${host} answered with a redirect, which Josi does not follow`, { category: 'provider_error', status: res.status });
    }
    return { res, host, finish };
  } catch (err) {
    await finish();
    if (err instanceof McpError) throw err;
    // Never `err.message`: a fetch error can carry the address and its headers.
    throw new McpError(`Josi could not reach ${host}`, { category: 'network' });
  }
}

/** Reads at most `max` bytes. More than that is a refusal, not a fragment. */
export async function readMcpBody(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new McpError('the server sent more than Josi will read in one answer', { category: 'provider_error' });
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

type RpcReply = { id?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };

function matchReply(message: unknown, id: number): RpcReply | null {
  const candidates = Array.isArray(message) ? message : [message];
  for (const item of candidates) {
    if (item && typeof item === 'object' && (item as RpcReply).id === id
      && ('result' in (item as object) || 'error' in (item as object))) return item as RpcReply;
  }
  return null;
}

/** Reads an event stream until the reply to request `id` arrives, then stops
 * listening. Anything else on the stream (progress, the server's own requests)
 * is ignored: Josi declares no abilities a server could call back into. */
async function readEventStreamReply(res: Response, id: number): Promise<RpcReply> {
  const reader = res.body?.getReader();
  if (!reader) throw new McpError('the server sent an empty answer', { category: 'provider_error' });
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  const take = (block: string): RpcReply | null => {
    const data = block.split('\n').filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, '')).join('\n');
    if (!data) return null;
    try { return matchReply(JSON.parse(data), id); } catch { return null; }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        total += value.byteLength;
        if (total > MCP_MAX_RESPONSE_BYTES) {
          throw new McpError('the server sent more than Josi will read in one answer', { category: 'provider_error' });
        }
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n');
        let cut = buffer.indexOf('\n\n');
        while (cut !== -1) {
          const reply = take(buffer.slice(0, cut));
          buffer = buffer.slice(cut + 2);
          if (reply) return reply;
          cut = buffer.indexOf('\n\n');
        }
      }
      if (done) {
        const reply = take(buffer);
        if (reply) return reply;
        throw new McpError('the server closed its answer before finishing it', { category: 'provider_error' });
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

// --------------------------------------------------------------- protocol

export interface McpTarget {
  url: string;
  /** The sign-in, already turned into headers. Used once per request and never
   * stored on anything this file returns. */
  authHeaders: Record<string, string>;
}

export interface McpSession {
  sessionId: string | null;
  protocolVersion: string;
  serverName: string | null;
}

function statusError(host: string, res: Response): McpError {
  const status = res.status;
  if (status === 401) {
    return new McpError(`${host} asked for a sign-in`, {
      category: 'revoked', status, unauthorized: true,
      wwwAuthenticate: (res.headers.get('www-authenticate') ?? '').slice(0, 2000) || null,
    });
  }
  const category: ErrorCategory = status === 403 ? 'insufficient_scope' : status === 429 ? 'rate_limited' : 'provider_error';
  const sentence = status === 403 ? `${host} accepted the sign-in but refused this request`
    : status === 429 ? `${host} is asking Josi to slow down`
      : status === 404 || status === 405 ? `${host} did not answer as an MCP server at that address`
        : `${host} returned an error`;
  return new McpError(sentence, { category, status });
}

/** Removes the sign-in from text a server sent back. A server that echoes the
 * request it was given must not be the way a token reaches a conversation. */
function withoutSignIn(text: string, authHeaders: Record<string, string>): string {
  let out = text;
  for (const value of Object.values(authHeaders)) {
    for (const piece of [value, value.replace(/^Bearer\s+/i, '')]) {
      if (piece.length >= 6) out = out.split(piece).join('[sign-in removed]');
    }
  }
  return out;
}

let nextId = 1;

async function rpc(
  target: McpTarget,
  session: McpSession | null,
  method: string,
  params: Record<string, unknown> | undefined,
  opts: McpNetOptions,
  notification = false,
): Promise<{ result: Record<string, unknown>; sessionId: string | null }> {
  const id = nextId++;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': 'josi-ce',
    ...target.authHeaders,
  };
  if (session?.sessionId) headers['mcp-session-id'] = session.sessionId;
  if (session) headers['mcp-protocol-version'] = session.protocolVersion;
  const body = JSON.stringify(notification
    ? { jsonrpc: '2.0', method, ...(params ? { params } : {}) }
    : { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

  const { res, host, finish } = await mcpOpen(target.url, { method: 'POST', headers, body }, opts);
  try {
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => undefined);
      throw statusError(host, res);
    }
    const sessionId = (res.headers.get('mcp-session-id') ?? '').trim();
    // A session id travels in a header on every later request, so it must be
    // something a header can carry and nothing else.
    const cleanSession = /^[\x21-\x7e]{1,256}$/.test(sessionId) ? sessionId : null;
    if (notification) {
      await res.body?.cancel().catch(() => undefined);
      return { result: {}, sessionId: cleanSession };
    }
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    let reply: RpcReply | null;
    if (type.includes('text/event-stream')) {
      reply = await readEventStreamReply(res, id);
    } else {
      const text = await readMcpBody(res, MCP_MAX_RESPONSE_BYTES);
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch {
        throw new McpError(`${host} did not answer as an MCP server`, { category: 'provider_error' });
      }
      reply = matchReply(parsed, id);
    }
    if (!reply) throw new McpError(`${host} did not answer the question it was asked`, { category: 'provider_error' });
    if (reply.error) {
      const code = typeof reply.error.code === 'number' ? reply.error.code : null;
      throw new McpError(`${host} refused that request`, {
        category: 'provider_error', rpcCode: code,
        serverSaid: cleanMcpLine(withoutSignIn(typeof reply.error.message === 'string' ? reply.error.message : '', target.authHeaders), 300) || null,
      });
    }
    if (!reply.result || typeof reply.result !== 'object' || Array.isArray(reply.result)) {
      throw new McpError(`${host} sent an answer Josi could not read`, { category: 'provider_error' });
    }
    return { result: reply.result as Record<string, unknown>, sessionId: cleanSession };
  } catch (err) {
    if (err instanceof McpError) throw err;
    throw new McpError(`Josi could not read the answer from ${host}`, { category: 'network' });
  } finally {
    await finish();
  }
}

/** Opens a session: `initialize`, then the `initialized` notice the protocol
 * requires before anything else may be asked. */
export async function mcpInitialize(target: McpTarget, opts: McpNetOptions = {}): Promise<McpSession> {
  const { result, sessionId } = await rpc(target, null, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    // No abilities offered back: no sampling, no roots, no elicitation. A
    // server has nothing here to call.
    capabilities: {},
    clientInfo: { name: 'josi', version: '1' },
  }, opts);
  const version = typeof result.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(result.protocolVersion)
    ? result.protocolVersion : null;
  if (!version) throw new McpError('the server did not say which version of MCP it speaks', { category: 'provider_error' });
  const info = result.serverInfo && typeof result.serverInfo === 'object' ? result.serverInfo as Record<string, unknown> : {};
  const session: McpSession = { sessionId, protocolVersion: version, serverName: cleanMcpLine(info.name, 120) || null };
  await rpc(target, session, 'notifications/initialized', undefined, opts, true);
  return session;
}

/** Ends a session the server gave an id to. Good manners, never required: a
 * failure here changes nothing. */
export async function mcpClose(target: McpTarget, session: McpSession, opts: McpNetOptions = {}): Promise<void> {
  if (!session.sessionId) return;
  try {
    const { res, finish } = await mcpOpen(target.url, {
      method: 'DELETE',
      headers: { 'user-agent': 'josi-ce', ...target.authHeaders, 'mcp-session-id': session.sessionId, 'mcp-protocol-version': session.protocolVersion },
    }, { ...opts, timeoutMs: 5_000 });
    await res.body?.cancel().catch(() => undefined);
    await finish();
  } catch { /* the session expires on its own */ }
}

/** One tool, as kept. `name` is the server's own name, used only when calling
 * it back; `safe` is what a model-facing name is built from. */
export interface McpToolRecord {
  name: string;
  safe: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** What the server declared: annotations.readOnlyHint === true. */
  readOnly: boolean;
  /** Whether Josi asks the person before running it. Decided by the caller
   * from `readOnly` and from what this tool was the first time it was seen —
   * never from a description. */
  asks: boolean;
}

export interface McpToolList {
  tools: McpToolRecord[];
  /** Tools left out: too many, an unusable name, or too large a description
   * of their input. */
  dropped: number;
}

/** Turns one entry of `tools/list` into a kept tool, or null. Exported so the
 * cleaning can be tested without a server. */
export function readMcpTool(raw: unknown, taken: Set<string>): McpToolRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const name = entry.name;
  // The name is sent back to the server verbatim, so it must be a plain,
  // printable, bounded string — otherwise there is nothing safe to send.
  if (typeof name !== 'string' || !name || name.length > MAX_TOOL_NAME_CHARS || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  const schemaRaw = entry.inputSchema && typeof entry.inputSchema === 'object' && !Array.isArray(entry.inputSchema)
    ? entry.inputSchema : { type: 'object', properties: {} };
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(schemaRaw), 'utf8'); } catch { return null; }
  if (size > MCP_MAX_SCHEMA_BYTES) return null;
  const inputSchema = cleanSchema(schemaRaw) as Record<string, unknown>;
  if (inputSchema.type !== 'object') inputSchema.type = 'object';
  if (!inputSchema.properties || typeof inputSchema.properties !== 'object') inputSchema.properties = {};

  let safe = mcpSafeName(name);
  for (let n = 2; taken.has(safe); n += 1) safe = `${mcpSafeName(name).slice(0, 60)}_${n}`;
  taken.add(safe);

  const annotations = entry.annotations && typeof entry.annotations === 'object' ? entry.annotations as Record<string, unknown> : {};
  // Strictly `true`. Missing, "true", 1 and everything else mean "ask first".
  const readOnly = annotations.readOnlyHint === true;
  return {
    name, safe,
    description: cleanMcpLine(entry.description, MCP_MAX_DESCRIPTION_CHARS) || cleanMcpLine(entry.title ?? annotations.title, MCP_MAX_DESCRIPTION_CHARS),
    inputSchema, readOnly, asks: !readOnly,
  };
}

/** The server's tools, page by page, cleaned and bounded. */
export async function mcpListTools(target: McpTarget, session: McpSession, opts: McpNetOptions = {}): Promise<McpToolList> {
  const tools: McpToolRecord[] = [];
  const taken = new Set<string>();
  const names = new Set<string>();
  let dropped = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_TOOL_PAGES; page += 1) {
    const { result } = await rpc(target, session, 'tools/list', cursor ? { cursor } : undefined, opts);
    const list = Array.isArray(result.tools) ? result.tools : [];
    for (const raw of list) {
      if (tools.length >= MCP_MAX_TOOLS) { dropped += 1; continue; }
      const rawName = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).name : null;
      // A second tool with a name already seen is ignored: the first one is
      // what the person was shown.
      if (typeof rawName === 'string' && names.has(rawName)) { dropped += 1; continue; }
      const tool = readMcpTool(raw, taken);
      if (!tool) { dropped += 1; continue; }
      names.add(tool.name);
      tools.push(tool);
    }
    const next = result.nextCursor;
    if (typeof next !== 'string' || !next || next.length > 2000 || next === cursor) break;
    cursor = next;
  }
  return { tools, dropped };
}

export interface McpToolResult {
  /** The text the tool returned, cleaned. Data from an outside server. */
  text: string;
  /** The tool itself said it failed. */
  isError: boolean;
  /** The text was longer than Josi passes on; this is the beginning. */
  truncated: boolean;
  /** Kinds of content that were left out (pictures, sound, files). */
  dropped: string[];
}

/** Reads a `tools/call` result. Text only; everything else is counted and
 * named so the assistant can say it was left out. */
export function readMcpToolResult(result: Record<string, unknown>): McpToolResult {
  const parts: string[] = [];
  const dropped = new Set<string>();
  const content = Array.isArray(result.content) ? result.content.slice(0, 200) : [];
  for (const item of content) {
    if (!item || typeof item !== 'object') continue;
    const piece = item as Record<string, unknown>;
    if (piece.type === 'text' && typeof piece.text === 'string') parts.push(cleanMcpText(piece.text));
    else dropped.add(cleanMcpLine(piece.type, 30) || 'unknown');
  }
  if (!parts.length && result.structuredContent && typeof result.structuredContent === 'object') {
    try { parts.push(cleanMcpText(JSON.stringify(result.structuredContent))); } catch { /* nothing usable */ }
  }
  const joined = parts.join('\n');
  const truncated = joined.length > MCP_MAX_RESULT_CHARS;
  return {
    text: truncated ? joined.slice(0, MCP_MAX_RESULT_CHARS) : joined,
    isError: result.isError === true,
    truncated,
    dropped: [...dropped].slice(0, 10),
  };
}

/** Calls one tool with exactly these arguments. */
export async function mcpCallTool(
  target: McpTarget,
  session: McpSession,
  name: string,
  args: Record<string, unknown>,
  opts: McpNetOptions = {},
): Promise<McpToolResult> {
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MCP_MAX_ARGUMENT_BYTES) {
    throw new McpError('those details are larger than Josi will send to a tool', { category: 'provider_error' });
  }
  const { result } = await rpc(target, session, 'tools/call', { name, arguments: args }, opts);
  const read = readMcpToolResult(result);
  return { ...read, text: withoutSignIn(read.text, target.authHeaders) };
}
