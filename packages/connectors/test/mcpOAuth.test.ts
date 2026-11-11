// Browser sign-in for an MCP server, against a pretend sign-in server.
//
// Discovery, self-registration, PKCE, the code exchange and the refresh, each
// on its own. The whole journey through the routes is in
// apps/api/test/customMcp.test.ts.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { McpError } from '../src/mcpClient.js';
import {
  buildMcpAuthorizationUrl, createMcpPkce, discoverMcpOAuth, exchangeMcpOAuthCode, parseWwwAuthenticate,
  refreshMcpOAuthTokens, registerMcpOAuthClient,
} from '../src/mcpOAuth.js';
import { fakeMcp } from './mcpFake.js';

const REDIRECT = 'https://josi.example.test/api/connections/mcp/oauth/callback';
const net = (server: ReturnType<typeof fakeMcp>) => ({ fetchImpl: server.fetch, resolve: server.resolve });

describe('finding where to sign in', () => {
  it('reads resource_metadata and scope from the 401', () => {
    expect(parseWwwAuthenticate('Bearer realm="x", resource_metadata="https://a.test/.well-known/oauth-protected-resource", scope="read write"'))
      .toEqual({ resourceMetadata: 'https://a.test/.well-known/oauth-protected-resource', scope: 'read write' });
    expect(parseWwwAuthenticate(null)).toEqual({ resourceMetadata: null, scope: null });
  });

  it('follows the 401 to the resource document, then to the sign-in server', async () => {
    const server = fakeMcp({ oauth: {} });
    const found = await discoverMcpOAuth(server.url, 'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"', net(server));
    expect(found).toEqual({
      resource: 'https://mcp.example.test/mcp',
      issuer: 'https://login.example.test/',
      authorizationEndpoint: 'https://login.example.test/authorize',
      tokenEndpoint: 'https://login.example.test/token',
      registrationEndpoint: 'https://login.example.test/register',
      scopes: ['tools.read', 'tools.write'],
    });
    expect(server.seen.map((r) => r.url)).toEqual([
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
      'https://login.example.test/.well-known/oauth-authorization-server',
    ]);
    expect(server.seen.every((r) => r.method === 'GET')).toBe(true);
  });

  it('falls back to the well-known address when the 401 names none, and to openid-configuration', async () => {
    const server = fakeMcp({ oauth: { openidOnly: true } });
    const found = await discoverMcpOAuth(server.url, 'Bearer', net(server));
    expect(found.tokenEndpoint).toBe('https://login.example.test/token');
    expect(server.seen.map((r) => r.url)).toEqual([
      'https://mcp.example.test/.well-known/oauth-protected-resource/mcp',
      'https://login.example.test/.well-known/oauth-authorization-server',
      'https://login.example.test/.well-known/openid-configuration',
    ]);
  });

  it('treats a server with no resource document as its own sign-in server', async () => {
    const server = fakeMcp({ oauth: { noResourceDocument: true, issuer: 'https://mcp.example.test' } });
    const found = await discoverMcpOAuth(server.url, null, net(server));
    expect(found.authorizationEndpoint).toBe('https://mcp.example.test/authorize');
    expect(found.resource).toBe('https://mcp.example.test/mcp');
  });

  it('refuses sign-in details published for a different server', async () => {
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('oauth-protected-resource')) return Response.json({ authorization_servers: ['https://login.example.test'] });
      return Response.json({ issuer: 'https://evil.example.test', authorization_endpoint: 'https://evil.example.test/a', token_endpoint: 'https://evil.example.test/t' });
    };
    await expect(discoverMcpOAuth('https://mcp.example.test/mcp', null, { fetchImpl, resolve: async () => ['93.184.216.34'] }))
      .rejects.toThrow(/different server/);
  });

  it('refuses a sign-in server that cannot do PKCE S256, and one with non-https addresses', async () => {
    const make = (doc: Record<string, unknown>): typeof fetch => async (input) => (String(input).includes('oauth-protected-resource')
      ? Response.json({ authorization_servers: ['https://login.example.test'] })
      : Response.json({ issuer: 'https://login.example.test', ...doc }));
    const resolve = async () => ['93.184.216.34'];
    await expect(discoverMcpOAuth('https://mcp.example.test/mcp', null, {
      resolve, fetchImpl: make({ authorization_endpoint: 'https://login.example.test/a', token_endpoint: 'https://login.example.test/t', code_challenge_methods_supported: ['plain'] }),
    })).rejects.toThrow(/PKCE/);
    await expect(discoverMcpOAuth('https://mcp.example.test/mcp', null, {
      resolve, fetchImpl: make({ authorization_endpoint: 'http://login.example.test/a', token_endpoint: 'https://login.example.test/t' }),
    })).rejects.toThrow(/usable sign-in addresses/);
  });

  it('will not fetch a sign-in document from a private address a server points it at', async () => {
    let asked = 0;
    const fetchImpl: typeof fetch = async () => { asked += 1; return Response.json({}); };
    const resolve = async (host: string) => (host === 'internal.example.test' ? ['10.0.0.7'] : ['93.184.216.34']);
    await expect(discoverMcpOAuth('https://mcp.example.test/mcp', 'Bearer resource_metadata="https://internal.example.test/meta"', { fetchImpl, resolve }))
      .rejects.toThrow(/public internet/);
    expect(asked).toBe(0);
  });

  it('says so plainly when a server asks for a sign-in and publishes nowhere to do it', async () => {
    const fetchImpl: typeof fetch = async () => new Response('nope', { status: 404 });
    const err = await discoverMcpOAuth('https://mcp.example.test/mcp', null, { fetchImpl, resolve: async () => ['93.184.216.34'] }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toMatch(/does not say where to sign in/);
  });
});

describe('registering, signing in and refreshing', () => {
  async function discovered(server: ReturnType<typeof fakeMcp>) {
    return discoverMcpOAuth(server.url, null, net(server));
  }

  it('registers Josi with its return address and no secret of its own', async () => {
    const server = fakeMcp({ oauth: {} });
    const client = await registerMcpOAuthClient(await discovered(server), { redirectUri: REDIRECT }, net(server));
    expect(client).toEqual({ clientId: 'registered-client', clientSecret: null, tokenAuth: 'none' });
    const sent = JSON.parse(server.oauthLog[0].params.body);
    expect(sent.redirect_uris).toEqual([REDIRECT]);
    expect(sent.grant_types).toEqual(['authorization_code', 'refresh_token']);
    expect(sent.token_endpoint_auth_method).toBe('none');
  });

  it('builds a sign-in address with PKCE S256, the state and the resource', async () => {
    const server = fakeMcp({ oauth: {} });
    const metadata = await discovered(server);
    const { verifier, challenge } = createMcpPkce();
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    const url = new URL(buildMcpAuthorizationUrl(metadata, { clientId: 'c1', redirectUri: REDIRECT, state: 'st', challenge }));
    expect(url.origin + url.pathname).toBe('https://login.example.test/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code', client_id: 'c1', redirect_uri: REDIRECT, state: 'st',
      code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://mcp.example.test/mcp', scope: 'tools.read tools.write',
    });
    // The verifier is never in the address the browser is sent to.
    expect(url.toString()).not.toContain(verifier);
  });

  it('exchanges the code with the verifier, then refreshes', async () => {
    const server = fakeMcp({ oauth: { expiresIn: 120 } });
    const metadata = await discovered(server);
    const client = { clientId: 'registered-client', clientSecret: null, tokenAuth: 'none' as const };
    const { verifier, challenge } = createMcpPkce();
    const code = server.issueCode(challenge);

    const before = Date.now();
    const tokens = await exchangeMcpOAuthCode(metadata, client, { code, verifier, redirectUri: REDIRECT }, net(server));
    expect(tokens.accessToken).toBe('access-1');
    expect(tokens.refreshToken).toBe('refresh-1');
    expect(tokens.expiresAt).toBeGreaterThanOrEqual(before + 119_000);
    expect(server.oauthLog.at(-1)!.params).toMatchObject({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT,
      client_id: 'registered-client', resource: 'https://mcp.example.test/mcp',
    });

    const refreshed = await refreshMcpOAuthTokens(metadata, client, tokens.refreshToken!, net(server));
    expect(refreshed.accessToken).toBe('access-2');
    expect(refreshed.refreshToken).toBe('refresh-2');
    expect(server.oauthLog.at(-1)!.params).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'refresh-1' });
  });

  it('refuses a code presented with the wrong verifier, without repeating the server\'s words', async () => {
    const server = fakeMcp({ oauth: {} });
    const metadata = await discovered(server);
    const code = server.issueCode(createMcpPkce().challenge);
    const err = await exchangeMcpOAuthCode(metadata, { clientId: 'c', clientSecret: null, tokenAuth: 'none' },
      { code, verifier: createMcpPkce().verifier, redirectUri: REDIRECT }, net(server)).catch((e) => e) as McpError;
    expect(err).toBeInstanceOf(McpError);
    expect(err.unauthorized).toBe(true);
    expect(err.message).not.toContain('do-not-repeat-this-text');
  });

  it('sends a client secret the way the client was registered', async () => {
    const seen: Array<{ headers: Record<string, string>; body: string }> = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      seen.push({ headers: init!.headers as Record<string, string>, body: String(init!.body) });
      return Response.json({ access_token: 'a', token_type: 'bearer' });
    };
    const metadata = { resource: 'https://mcp.example.test/mcp', issuer: 'https://login.example.test/', authorizationEndpoint: 'https://login.example.test/a',
      tokenEndpoint: 'https://login.example.test/t', registrationEndpoint: null, scopes: [] };
    const opts = { fetchImpl, resolve: async () => ['93.184.216.34'] };
    await exchangeMcpOAuthCode(metadata, { clientId: 'c', clientSecret: 'shh', tokenAuth: 'client_secret_post' }, { code: 'x', verifier: 'v', redirectUri: REDIRECT }, opts);
    await exchangeMcpOAuthCode(metadata, { clientId: 'c', clientSecret: 'shh', tokenAuth: 'client_secret_basic' }, { code: 'x', verifier: 'v', redirectUri: REDIRECT }, opts);
    expect(new URLSearchParams(seen[0].body).get('client_secret')).toBe('shh');
    expect(seen[0].headers.authorization).toBeUndefined();
    expect(new URLSearchParams(seen[1].body).get('client_secret')).toBeNull();
    expect(seen[1].headers.authorization).toBe(`Basic ${Buffer.from('c:shh').toString('base64')}`);
  });

  it('keeps the old refresh token when the server does not issue a new one', async () => {
    const fetchImpl: typeof fetch = async () => Response.json({ access_token: 'new-access', token_type: 'Bearer', expires_in: 60 });
    const metadata = { resource: 'https://mcp.example.test/mcp', issuer: 'https://login.example.test/', authorizationEndpoint: 'https://login.example.test/a',
      tokenEndpoint: 'https://login.example.test/t', registrationEndpoint: null, scopes: [] };
    const tokens = await refreshMcpOAuthTokens(metadata, { clientId: 'c', clientSecret: null, tokenAuth: 'none' }, 'old-refresh', { fetchImpl, resolve: async () => ['93.184.216.34'] });
    expect(tokens.refreshToken).toBe('old-refresh');
  });
});
