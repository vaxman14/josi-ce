// Speaking MCP to somebody else's server.
//
// CE has had an MCP server since Phase 4 (`packages/agent/src/mcp/`): the thing
// a vendor CLI spawns to reach Josi's tools. This file is the other direction
// and shares nothing with it but the vocabulary — here Josi is the CLIENT, the
// far end is a stranger, and every assumption that made the server side simple
// is inverted.
//
// EVERY DANGEROUS THING ABOUT THIS FEATURE IS IN THIS FILE, so the rules are
// code rather than convention, and each one is exported so a test can attack it
// directly instead of only through a route.
//
//   * ONE TRANSPORT: Streamable HTTP over HTTPS. Not stdio, not now and not
//     later. A stdio MCP server is a command line executed inside CE's own
//     container — remote code execution offered as a text field. Not the
//     deprecated HTTP+SSE transport either: it needs a long-lived GET whose
//     lifetime the server chooses, which is an inbound channel a remote party
//     holds open through this process.
//   * THE HOST COLUMN IS THE ALLOWLIST. Every request re-parses the URL it is
//     about to send and refuses unless the hostname equals `server.host`
//     exactly. Done on the URL that will be SENT, because a check on the pieces
//     that went into it is a check on the wrong thing.
//   * ADDRESSES ARE CHECKED AT REQUEST TIME, not once at save time. A hostname
//     that resolves to something benign when the owner tested it and to
//     169.254.169.254 when the assistant uses it is the whole DNS-rebinding
//     trick, and re-checking costs nothing.
//   * PUBLIC ADDRESSES ONLY. The opposite of packages/llm/src/ssrf.ts, and
//     deliberately: that module must permit loopback and LAN addresses because
//     self-hosted inference is the point of it, and nothing chooses its path.
//     Here the ASSISTANT chooses which tool to invoke, so an internal address
//     would turn a model's choice into a request against this network.
//     `nonPublicReason` is IMPORTED from devServiceProbe rather than copied: it
//     is a pure predicate with exactly one policy, and this feature wants that
//     same answer.
//   * REDIRECTS ARE NOT FOLLOWED. Validating a URL and then chasing a 302
//     checks the wrong URL.
//   * NOTHING THE SERVER SAYS REACHES A LOG, AN AUDIT PAYLOAD OR A DIAGNOSTIC.
//     A remote server's error text is attacker-influenced and may quote the
//     request back — and a request here carries somebody's token. Failures
//     become an `ErrorCategory` and a sentence CE wrote. A successful tool
//     result does go back to the assistant, which is the point of the feature,
//     capped and never logged.
//   * `instructions` IS READ AND DROPPED. MCP lets a server return prose meant
//     to be pasted into the model's system prompt. Keeping it would hand a
//     remote party a writable region of Josi's own instructions. It is the
//     clearest prompt-injection channel the protocol offers and CE declines it.
import { isIP } from 'node:net';
import { nonPublicReason } from './devServiceProbe.js';
import { ConnectorError, type ErrorCategory } from './providers.js';

/** A refusal from this layer. Carries a category the UI already knows how to
 * say in plain language, and a message CE wrote — never the server's. */
export class McpError extends ConnectorError {}

/** The revision CE speaks. Streamable HTTP is the transport this and every
 * later revision define; an older server that answers with its own revision is
 * accepted, because the four methods used here have been stable across every
 * published revision. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/** A server that has not answered in twenty seconds is a server somebody is
 * waiting on. Long enough for a cold service, short enough that a conversation
 * does not stall behind it. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** The most of one response Josi will read. Anything larger is either the wrong
 * endpoint or something trying to make this process hold it in memory. */
const MAX_BODY_BYTES = 1024 * 1024;

/** The most of a tool result that goes back to the assistant. Smaller than what
 * is read, because a model context is not a place to put a megabyte of
 * somebody's notes. Truncation is always stated rather than silent. */
export const MAX_MODEL_RESULT_CHARS = 20_000;

/** The most tools one server may offer. A server answering with fifty thousand
 * tools is not a catalogue, and paging through it forever is a way to make this
 * process spend an afternoon. */
export const MAX_TOOLS_PER_SERVER = 250;

/** How many `tools/list` pages will be followed. */
const MAX_TOOL_PAGES = 20;

/** The largest arguments object a tool call may carry. */
const MAX_ARGUMENTS_BYTES = 64 * 1024;

export interface McpFetchOptions {
  /** Injected by the tests, so no suite contacts a real MCP server. Unset in
   * production. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the SSRF suite to answer with a hostile
   * address. Unset in production, where the host's own resolver is used. */
  resolve?: (hostname: string) => Promise<string[]>;
  timeoutMs?: number;
}

/** Everything a request needs, and nothing that identifies a person. Taken as a
 * shape rather than a row so a test can drive this file without a database. */
export interface McpEndpoint {
  name: string;
  endpoint_url: string;
  host: string;
  auth_kind: 'none' | 'bearer' | 'api_key';
  auth_header: string | null;
}

/** The credential, opened for one exchange. `null` when the server takes none. */
export type McpSecret = { secret: string } | null;

// ------------------------------------------------------------------ headers

/** The credential, applied.
 *
 * The one function that turns an opened secret into a header, kept separate
 * from the request so a test can assert what it produces without sending
 * anything — and so there is exactly one place to look when asking "where does
 * the secret go?". It goes in a header and never in the URL: a URL reaches
 * logs, proxies and error messages.
 */
export function mcpAuthHeaders(
  server: Pick<McpEndpoint, 'auth_kind' | 'auth_header'>,
  secret: McpSecret,
): Record<string, string> {
  if (server.auth_kind === 'none') return {};
  if (!secret || !secret.secret) {
    throw new McpError('that server is not configured properly', { category: 'provider_error' });
  }
  if (server.auth_kind === 'bearer') return { authorization: `Bearer ${secret.secret}` };
  const header = server.auth_header;
  if (!header) {
    throw new McpError('that server is not configured properly', { category: 'provider_error' });
  }
  return { [header.toLowerCase()]: secret.secret };
}

// -------------------------------------------------------------- the address

async function defaultResolve(hostname: string): Promise<string[]> {
  const { lookup } = await import('node:dns/promises');
  const results = await lookup(hostname, { all: true, verbatim: true });
  return results.map((r) => r.address);
}

/**
 * Resolves a host and refuses anything that is not on the public internet.
 *
 * Exported because it is the SSRF control, and a control that can only be
 * exercised through a full session is a control that gets tested once.
 */
export async function assertPublicMcpHost(
  host: string,
  opts: McpFetchOptions = {},
): Promise<string[]> {
  // A URL that is already a literal address never reaches a resolver, so it
  // would sail past a check that only inspects DNS answers.
  if (isIP(host)) {
    const reason = nonPublicReason(host);
    if (reason) {
      throw new McpError(
        `${host} is ${reason}, and Josi only contacts MCP servers on the public internet.`,
        { category: 'network' },
      );
    }
    return [host];
  }

  let addresses: string[];
  try {
    addresses = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    throw new McpError(`${host} could not be looked up from this server`, { category: 'network' });
  }
  if (!addresses.length) {
    throw new McpError(`${host} resolved to no addresses from this server`, { category: 'network' });
  }
  // EVERY address, not the first: a hostname answering with one public and one
  // metadata address is an attack, not a lucky draw.
  for (const address of addresses) {
    const reason = nonPublicReason(address);
    if (reason) {
      throw new McpError(
        `${host} resolved to ${reason} on this server, so Josi refused the request. An MCP server `
        + 'must be reachable on the public internet.',
        { category: 'network' },
      );
    }
  }
  return addresses;
}

/** THE CHECK. Everything else is construction; this is the invariant.
 *
 * Re-parses the URL that is about to be sent and refuses unless it is the same
 * https endpoint on the same host the row pins. Called on every request rather
 * than once per session, because a session is several requests and "the first
 * one was fine" is not a property of the fourth. */
function assertPinned(server: McpEndpoint): string {
  let url: URL;
  try {
    url = new URL(server.endpoint_url);
  } catch {
    throw new McpError('that server address could not be used', { category: 'provider_error' });
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || hostname !== server.host || url.username || url.password) {
    throw new McpError(
      `that request would leave ${server.name}, so Josi refused to make it`,
      { category: 'provider_error' },
    );
  }
  return url.toString();
}

// ------------------------------------------------------------------- frames

interface JsonRpcResponse {
  id?: unknown;
  result?: unknown;
  error?: { code?: unknown; message?: unknown };
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpError(
        'that server sent more than Josi will read in one answer',
        { category: 'provider_error' },
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Pulls the JSON-RPC messages out of one response body.
 *
 * A Streamable HTTP server may answer a POST with a single JSON object or with
 * an SSE stream carrying one. Both are handled here rather than in the caller,
 * because "which shape did it use?" is a transport detail and not a question
 * the rest of this file should be able to get wrong.
 *
 * Exported for the tests: the SSE parser is the one place a hostile server gets
 * to choose the framing.
 */
export function parseMcpFrames(contentType: string | null, text: string): JsonRpcResponse[] {
  const body = text.trim();
  if (!body) return [];

  if ((contentType ?? '').toLowerCase().includes('text/event-stream')) {
    const out: JsonRpcResponse[] = [];
    // One event per blank-line-separated block; `data:` lines within a block
    // are joined with newlines, which is what the SSE grammar says.
    for (const block of body.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        const parsed = JSON.parse(data) as JsonRpcResponse | JsonRpcResponse[];
        if (Array.isArray(parsed)) out.push(...parsed);
        else out.push(parsed);
      } catch {
        // A frame that is not JSON is not a message. Skipping it beats failing
        // the whole exchange over a comment or a keep-alive.
      }
    }
    return out;
  }

  try {
    const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new McpError(
      'that server did not answer with MCP. Check the address is the server\'s MCP endpoint '
      + 'rather than its website.',
      { category: 'provider_error' },
    );
  }
}

/** What an HTTP status from an arbitrary MCP server means to the person who has
 * to fix it. Never the server's own words. */
export function categoryForMcpStatus(status: number): ErrorCategory {
  if (status === 401) return 'revoked';
  if (status === 403) return 'insufficient_scope';
  if (status === 429) return 'rate_limited';
  return 'provider_error';
}

/** The sentence shown when a server refuses. Written here, in CE's words, for
 * every category — so no code path is tempted to pass a server's error body
 * through to a screen. */
export function mcpSentence(name: string, category: ErrorCategory): string {
  switch (category) {
    case 'revoked':
      return `${name} did not accept the stored credential. It may have been revoked, rotated or mistyped.`;
    case 'insufficient_scope':
      return `${name} accepted the credential but refused this request, which usually means the `
        + 'credential is not permitted to do this.';
    case 'rate_limited':
      return `${name} is asking Josi to slow down. Nothing is wrong with the credential.`;
    case 'expired':
      return `The credential for ${name} has expired. Replace it on the MCP servers page.`;
    case 'network':
      return `Josi could not reach ${name}.`;
    default:
      return `${name} did not answer as an MCP server should.`;
  }
}

// ------------------------------------------------------------------ session

export interface McpSession {
  server: McpEndpoint;
  secret: McpSecret;
  opts: McpFetchOptions;
  /** `Mcp-Session-Id`, when the server issued one. Echoed on every later
   * request in the same exchange. */
  sessionId: string | null;
  /** What the server said it speaks. Sent back as `MCP-Protocol-Version`. */
  protocolVersion: string;
  /** `name` and `version` from `serverInfo`, cleaned and capped. The server's
   * own words, shown to the owner so they can see they are talking to what they
   * think they are. */
  serverLabel: string | null;
  /** Whether the server declared a `tools` capability. A server with none has
   * nothing this feature can use, and saying so beats an empty list. */
  offersTools: boolean;
}

/** The server's own words, made safe to store and to show.
 *
 * Control characters, line breaks and length are all attacker-chosen, and all
 * three end up on a screen or in a prompt. */
export function cleanServerText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  // Written as escapes so this file contains none of them: a line break inside
  // a tool description reaches a prompt as a line of its own, and a control
  // character reaches a terminal.
  return raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

let nextRequestId = 1;

/** One JSON-RPC request, one HTTP request, one answer. */
async function rpc(
  session: McpSession,
  method: string,
  params: Record<string, unknown> | undefined,
  expectAnswer: boolean,
): Promise<{ result: unknown; sessionId: string | null }> {
  const { server, opts } = session;
  const url = assertPinned(server);
  await assertPublicMcpHost(server.host, opts);

  const id = nextRequestId++;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    // Both, because a Streamable HTTP server may answer either way and a client
    // that accepts only one is a client half of them refuse.
    accept: 'application/json, text/event-stream',
    // Named so an operator reading their own server's access log can see which
    // software called. Carries no version of anything sensitive.
    'user-agent': 'josi-ce',
    ...mcpAuthHeaders(server, session.secret),
  };
  if (session.sessionId) headers['mcp-session-id'] = session.sessionId;
  if (method !== 'initialize') headers['mcp-protocol-version'] = session.protocolVersion;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(
        expectAnswer
          ? { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }
          : { jsonrpc: '2.0', method, ...(params ? { params } : {}) },
      ),
      // Validating a URL and then chasing a 302 checks the wrong URL.
      redirect: 'manual',
      signal: controller.signal,
    });
  } catch {
    // Deliberately not `err.message`: an undici error can carry the request
    // URL, and the habit of interpolating fetch errors is how a header ends up
    // in a log.
    throw new McpError(`Josi could not reach ${server.name}`, { category: 'network' });
  } finally {
    clearTimeout(timer);
  }

  if (res.status >= 300 && res.status < 400) {
    throw new McpError(
      `${server.name} answered with a redirect, which Josi does not follow. If that server has `
      + 'moved, update its address on the MCP servers page.',
      { category: 'provider_error' },
    );
  }
  const sessionId = res.headers.get('mcp-session-id');

  if (res.status >= 400) {
    // The body is read and thrown away on purpose: it may quote the request,
    // and the request carried a credential.
    await readCapped(res).catch(() => '');
    const category = categoryForMcpStatus(res.status);
    throw new McpError(mcpSentence(server.name, category), { category });
  }

  // A notification gets 202 and no body. Asking for a result would be asking
  // for something the protocol says is not there.
  if (!expectAnswer) return { result: null, sessionId };

  const text = await readCapped(res);
  const frames = parseMcpFrames(res.headers.get('content-type'), text);
  const answer = frames.find((f) => f.id === id) ?? frames.find((f) => f.result || f.error);
  if (!answer) {
    throw new McpError(`${server.name} did not answer that request`, { category: 'provider_error' });
  }
  if (answer.error) {
    // The server's own message is NOT relayed. What it says about a request it
    // refused is text a remote party chose, and this one carried a credential.
    throw new McpError(`${server.name} refused that request (${method}).`, { category: 'provider_error' });
  }
  return { result: answer.result ?? null, sessionId };
}

/**
 * The handshake. `initialize`, then the `notifications/initialized` the
 * protocol requires before anything else may be asked.
 *
 * Returns a session rather than a boolean because `Mcp-Session-Id` and the
 * agreed protocol revision have to travel with every later request in the same
 * exchange, and a caller that had to remember to carry them is a caller that
 * eventually does not.
 */
export async function openMcpSession(
  args: { server: McpEndpoint; secret: McpSecret },
  opts: McpFetchOptions = {},
): Promise<McpSession> {
  const session: McpSession = {
    server: args.server,
    secret: args.secret,
    opts,
    sessionId: null,
    protocolVersion: MCP_PROTOCOL_VERSION,
    serverLabel: null,
    offersTools: false,
  };

  const { result, sessionId } = await rpc(session, 'initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    // Honest: CE offers a remote server no roots, no sampling and no
    // elicitation. Each of those is the server asking Josi to do something, and
    // none of them is a thing this feature is.
    capabilities: {},
    clientInfo: { name: 'josi-ce', version: '1.0.0' },
  }, true);

  const payload = (result ?? {}) as {
    protocolVersion?: unknown;
    capabilities?: { tools?: unknown };
    serverInfo?: { name?: unknown; version?: unknown };
    // Read, and dropped. See the header of this file.
    instructions?: unknown;
  };

  session.sessionId = sessionId;
  session.protocolVersion = cleanServerText(payload.protocolVersion, 40) || MCP_PROTOCOL_VERSION;
  const name = cleanServerText(payload.serverInfo?.name, 80);
  const version = cleanServerText(payload.serverInfo?.version, 30);
  session.serverLabel = name ? (version ? `${name} ${version}` : name) : null;
  session.offersTools = !!payload.capabilities?.tools;

  // The notification the protocol requires. Not optional and not deferred: a
  // spec-following server refuses everything else until it arrives.
  await rpc(session, 'notifications/initialized', undefined, false);
  return session;
}

/** Ends the session, best effort.
 *
 * A server that keeps per-session state should be told we are done with it. A
 * server that does not will answer 405, which is not a failure and is not
 * reported as one — this is politeness, not a control. */
export async function closeMcpSession(session: McpSession): Promise<void> {
  if (!session.sessionId) return;
  const { server, opts } = session;
  try {
    const url = assertPinned(server);
    await (opts.fetchImpl ?? fetch)(url, {
      method: 'DELETE',
      headers: {
        'mcp-session-id': session.sessionId,
        'mcp-protocol-version': session.protocolVersion,
        'user-agent': 'josi-ce',
        ...mcpAuthHeaders(server, session.secret),
      },
      redirect: 'manual',
    });
  } catch {
    // Nothing to do and nothing to say. The session ends when the far end
    // decides it does.
  }
}

// -------------------------------------------------------------------- tools

/** One tool, as the server described it and after CE has made it safe to store
 * and to show. Every string here is the remote server's words. */
export interface DiscoveredMcpTool {
  name: string;
  title: string | null;
  description: string;
  inputSchema: Record<string, unknown>;
  /** `annotations.readOnlyHint` — the server's OPINION of its own safety. Null
   * when it said nothing. Never treated as a permission. */
  readOnlyHint: boolean | null;
}

/** The tool name grammar, matching the CHECK in migration 0036. A name outside
 * it is dropped rather than sanitised: a name is an identifier the model repeats
 * back, and quietly rewriting one makes two tools with one name. */
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

/** The most JSON an input schema may be. A schema is given to the model as a
 * parameter definition, so a 200KB one is 200KB of somebody else's text in this
 * person's context window on every turn. */
const MAX_SCHEMA_CHARS = 20_000;

/** An input schema Josi will pass to a model.
 *
 * Objects only, and capped. Anything else is replaced with an empty object
 * schema rather than passed on: MCP says an input schema is an object schema,
 * and a tool whose schema is a string would make the arguments the model sends
 * unpredictable.
 */
export function cleanToolSchema(raw: unknown): Record<string, unknown> {
  const empty = { type: 'object', properties: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return empty;
  const schema = raw as Record<string, unknown>;
  if (schema.type !== 'object') return empty;
  if (JSON.stringify(schema).length > MAX_SCHEMA_CHARS) return empty;
  return schema;
}

/**
 * Asks the server what it offers, following `nextCursor` until it stops.
 *
 * Capped in two directions — pages and tools — because "how many tools does
 * this server have?" is a number the far end chooses.
 */
export async function mcpListTools(session: McpSession): Promise<DiscoveredMcpTool[]> {
  const out: DiscoveredMcpTool[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_TOOL_PAGES; page++) {
    const { result } = await rpc(session, 'tools/list', cursor ? { cursor } : {}, true);
    const payload = (result ?? {}) as { tools?: unknown; nextCursor?: unknown };
    const tools = Array.isArray(payload.tools) ? payload.tools : [];
    for (const raw of tools) {
      const tool = (raw ?? {}) as Record<string, unknown>;
      const name = typeof tool.name === 'string' ? tool.name : '';
      if (!TOOL_NAME.test(name)) continue;
      if (out.some((t) => t.name === name)) continue;
      const annotations = (tool.annotations ?? {}) as Record<string, unknown>;
      out.push({
        name,
        title: cleanServerText(tool.title, 200) || null,
        description: cleanServerText(tool.description, 2000),
        inputSchema: cleanToolSchema(tool.inputSchema),
        readOnlyHint: typeof annotations.readOnlyHint === 'boolean' ? annotations.readOnlyHint : null,
      });
      if (out.length >= MAX_TOOLS_PER_SERVER) return out;
    }
    const next = typeof payload.nextCursor === 'string' ? payload.nextCursor : '';
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

export interface McpToolResult {
  /** What the model gets to read. Text blocks only, joined and capped. */
  text: string;
  /** True when the server marked the result as a tool-level error. That is an
   * answer for the model to relay, not a transport failure. */
  isError: boolean;
  /** True when the result was longer than Josi will pass on, or when it carried
   * blocks Josi does not forward. Stated rather than silently dropped, so
   * nothing downstream treats a fragment as the whole answer. */
  truncated: boolean;
  /** Content block types that were present and not forwarded. */
  dropped: string[];
}

/** The arguments, checked before they leave.
 *
 * An object, and small. The model composes this from the server's own schema,
 * so it is not hostile — but it is unbounded, and an unbounded body is a body
 * somebody puts a document in. */
export function checkMcpArguments(args: unknown): Record<string, unknown> {
  if (args === undefined || args === null) return {};
  if (typeof args !== 'object' || Array.isArray(args)) {
    throw new McpError('the details for a tool must be an object of fields', { category: 'provider_error' });
  }
  const encoded = JSON.stringify(args);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENTS_BYTES) {
    throw new McpError('those details are larger than Josi will send', { category: 'provider_error' });
  }
  return args as Record<string, unknown>;
}

/**
 * Calls one tool.
 *
 * The name is passed straight through because it came from `mcp_server_tools`,
 * where it was matched against the grammar above before it was stored — the
 * model never supplies it as free text; it names a row that is looked up.
 */
export async function mcpCallTool(
  session: McpSession,
  args: { name: string; arguments?: unknown },
): Promise<McpToolResult> {
  const { result } = await rpc(session, 'tools/call', {
    name: args.name,
    arguments: checkMcpArguments(args.arguments),
  }, true);

  const payload = (result ?? {}) as {
    content?: unknown;
    isError?: unknown;
    structuredContent?: unknown;
  };

  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const parts: string[] = [];
  const dropped = new Set<string>();
  for (const raw of blocks) {
    const block = (raw ?? {}) as Record<string, unknown>;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
      continue;
    }
    // Images, audio and embedded resources are not forwarded. A remote server
    // returning a megabyte of base64 into somebody's model context is not a
    // thing to do quietly, and CE has no consent surface for "this tool sends
    // pictures into your conversation".
    dropped.add(typeof block.type === 'string' ? block.type.slice(0, 30) : 'unknown');
  }
  if (!parts.length && payload.structuredContent && typeof payload.structuredContent === 'object') {
    parts.push(JSON.stringify(payload.structuredContent));
  }

  const joined = parts.join('\n');
  const clipped = joined.length > MAX_MODEL_RESULT_CHARS;
  return {
    text: clipped ? joined.slice(0, MAX_MODEL_RESULT_CHARS) : joined,
    isError: payload.isError === true,
    truncated: clipped || dropped.size > 0,
    dropped: [...dropped],
  };
}
