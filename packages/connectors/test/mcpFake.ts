// A pretend MCP server, and a pretend sign-in server, as an injected fetch.
// No suite that uses this touches the network.
import { createHash } from 'node:crypto';

export interface SeenRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
  rpc: { id?: number; method?: string; params?: Record<string, unknown> } | null;
}

export interface FakeMcpOptions {
  /** Where the MCP server lives. */
  url?: string;
  tools?: unknown[];
  /** Answer as a short event stream instead of JSON. */
  sse?: boolean;
  pageSize?: number;
  sessionId?: string | null;
  protocolVersion?: unknown;
  /** Returns true when the request is signed in. Unset = no sign-in needed. */
  auth?: (headers: Record<string, string>) => boolean;
  wwwAuthenticate?: string;
  callTool?: (name: string, args: Record<string, unknown>) => unknown;
  /** Replace the reply to one JSON-RPC method entirely. */
  override?: (rpc: NonNullable<SeenRequest['rpc']>, req: SeenRequest) => Response | undefined;
  /** A sign-in server on `issuer`, with or without self-registration. */
  oauth?: {
    issuer?: string;
    registration?: boolean;
    /** Leave the protected-resource document out (an older server). */
    noResourceDocument?: boolean;
    /** Serve only the OpenID address, not the OAuth one. */
    openidOnly?: boolean;
    expiresIn?: number;
    rotateRefresh?: boolean;
  };
}

export interface FakeMcp {
  fetch: typeof fetch;
  seen: SeenRequest[];
  resolve: (host: string) => Promise<string[]>;
  url: string;
  options: FakeMcpOptions;
  /** Tool calls that actually reached the server. */
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Access tokens the sign-in server has issued and still honours. */
  validTokens: Set<string>;
  /** What the sign-in server was asked, in order. */
  oauthLog: Array<{ what: string; params: Record<string, string> }>;
  /** A code the sign-in server will accept once, for this challenge. */
  issueCode(challenge: string): string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export function fakeMcp(options: FakeMcpOptions = {}): FakeMcp {
  const url = options.url ?? 'https://mcp.example.test/mcp';
  const origin = new URL(url).origin;
  const issuer = options.oauth?.issuer ?? 'https://login.example.test';
  const seen: SeenRequest[] = [];
  const toolCalls: FakeMcp['toolCalls'] = [];
  const validTokens = new Set<string>();
  const oauthLog: FakeMcp['oauthLog'] = [];
  const codes = new Map<string, string>();
  const refreshTokens = new Set<string>();
  let minted = 0;
  const self: FakeMcp = {
    seen, toolCalls, validTokens, oauthLog, url, options,
    resolve: async () => ['93.184.216.34'],
    issueCode(challenge) { const code = `code-${codes.size + 1}`; codes.set(code, challenge); return code; },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input);
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const body = typeof init?.body === 'string' ? init.body : '';
      let rpc: SeenRequest['rpc'] = null;
      try { rpc = body.startsWith('{') ? JSON.parse(body) : null; } catch { rpc = null; }
      const req: SeenRequest = { url: target, method: init?.method ?? 'GET', headers, body, rpc };
      seen.push(req);
      const opts = self.options;
      const u = new URL(target);

      // ------------------------------------------------ the sign-in server
      if (opts.oauth) {
        if (target === `${origin}/.well-known/oauth-protected-resource${new URL(url).pathname}` || target === `${origin}/.well-known/oauth-protected-resource`) {
          if (opts.oauth.noResourceDocument) return json({ error: 'not found' }, 404);
          return json({ resource: url, authorization_servers: [issuer], scopes_supported: ['tools.read', 'tools.write'] });
        }
        const metadata = {
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
          ...(opts.oauth.registration === false ? {} : { registration_endpoint: `${issuer}/register` }),
          code_challenge_methods_supported: ['S256'],
        };
        if (target === `${issuer}/.well-known/oauth-authorization-server`) return opts.oauth.openidOnly ? json({}, 404) : json(metadata);
        if (target === `${issuer}/.well-known/openid-configuration`) return json(metadata);
        if (target === `${issuer}/register`) {
          oauthLog.push({ what: 'register', params: { body } });
          return json({ client_id: 'registered-client', token_endpoint_auth_method: 'none' }, 201);
        }
        if (target === `${issuer}/token`) {
          const params = Object.fromEntries(new URLSearchParams(body));
          oauthLog.push({ what: `token:${params.grant_type}`, params });
          const issue = () => {
            minted += 1;
            const access = `access-${minted}`;
            const refresh = `refresh-${minted}`;
            validTokens.add(access);
            refreshTokens.add(refresh);
            return json({ access_token: access, token_type: 'Bearer', expires_in: opts.oauth!.expiresIn ?? 3600, refresh_token: refresh });
          };
          if (params.grant_type === 'authorization_code') {
            const challenge = codes.get(params.code);
            codes.delete(params.code);
            const proved = createHash('sha256').update(params.code_verifier ?? '').digest('base64url');
            if (!challenge || challenge !== proved) return json({ error: 'invalid_grant', error_description: 'do-not-repeat-this-text' }, 400);
            return issue();
          }
          if (params.grant_type === 'refresh_token') {
            if (!refreshTokens.has(params.refresh_token)) return json({ error: 'invalid_grant' }, 400);
            if (opts.oauth.rotateRefresh !== false) refreshTokens.delete(params.refresh_token);
            return issue();
          }
          return json({ error: 'unsupported_grant_type' }, 400);
        }
      }

      // --------------------------------------------------- the MCP server
      if (u.origin + u.pathname !== url.split('?')[0]) return json({ error: 'no such address' }, 404);
      if (opts.auth && !opts.auth(headers)) {
        return new Response('sign in', { status: 401, headers: {
          'www-authenticate': opts.wwwAuthenticate ?? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${new URL(url).pathname}"`,
        } });
      }
      if (req.method === 'DELETE') return new Response(null, { status: 200 });
      if (!rpc) return json({ error: 'bad request' }, 400);
      const replaced = opts.override?.(rpc, req);
      if (replaced) return replaced;
      if (rpc.method === 'notifications/initialized') return new Response(null, { status: 202 });

      let result: unknown;
      if (rpc.method === 'initialize') {
        result = {
          protocolVersion: 'protocolVersion' in opts ? opts.protocolVersion : '2025-06-18',
          capabilities: { tools: {} }, serverInfo: { name: 'Fake Server', version: '1' },
        };
      } else if (rpc.method === 'tools/list') {
        const all = opts.tools ?? [];
        const size = opts.pageSize ?? all.length ?? 0;
        const start = Number(rpc.params?.cursor ?? 0);
        const page = size ? all.slice(start, start + size) : all;
        result = { tools: page, ...(size && start + size < all.length ? { nextCursor: String(start + size) } : {}) };
      } else if (rpc.method === 'tools/call') {
        const name = String(rpc.params?.name);
        const args = (rpc.params?.arguments ?? {}) as Record<string, unknown>;
        toolCalls.push({ name, arguments: args });
        result = opts.callTool?.(name, args) ?? { content: [{ type: 'text', text: `ran ${name} with ${JSON.stringify(args)}` }] };
      } else {
        return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } });
      }

      const session: Record<string, string> = rpc.method === 'initialize' && opts.sessionId !== null
        ? { 'mcp-session-id': opts.sessionId ?? 'session-abc' } : {};
      const reply = { jsonrpc: '2.0', id: rpc.id, result };
      if (opts.sse) {
        const stream = [
          `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`,
          `event: message\r\ndata: ${JSON.stringify(reply)}\r\n\r\n`,
        ].join('');
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream', ...session } });
      }
      return json(reply, 200, session);
    }) as typeof fetch,
  };
  return self;
}

/** A tool as a server would list it. */
export function tool(name: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name, description: `Does ${name}.`,
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    ...extra,
  };
}
export const readOnly = { annotations: { readOnlyHint: true } };
