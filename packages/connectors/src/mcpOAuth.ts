// Browser sign-in for an MCP server, following the MCP authorization rules.
//
// What happens, in order:
//
//   1. The server answers 401. Its WWW-Authenticate header may name a
//      `resource_metadata` document; otherwise the well-known address
//      /.well-known/oauth-protected-resource is asked.
//   2. That document names the authorization server. Its own description is
//      read from /.well-known/oauth-authorization-server, falling back to
//      /.well-known/openid-configuration.
//   3. If it offers a registration address (RFC 7591), Josi registers itself
//      as a client. If not, the person pastes a client id.
//   4. The person signs in in their browser: authorization code with PKCE
//      (S256) and a single-use state.
//   5. The code is exchanged for tokens. They are refreshed when they run out.
//
// Every address in steps 1 to 5 was published by an outside server, so every
// request goes through `mcpOpen`: https only, public addresses only, no
// redirects, a timeout and a size ceiling. Nothing a server says here reaches
// a log or an audit record, and no function in this file stores anything.
import { createHash, randomBytes } from 'node:crypto';
import { McpError, cleanMcpLine, mcpOpen, readMcpBody, type McpNetOptions } from './mcpClient.js';

const MAX_METADATA_BYTES = 256 * 1024;

/** What discovery found. None of it is secret. */
export interface McpOAuthMetadata {
  /** The value sent as `resource`, so a token is only good for this server. */
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  scopes: string[];
}

export interface McpOAuthClient {
  clientId: string;
  clientSecret: string | null;
  /** How the client proves itself at the token address. */
  tokenAuth: 'none' | 'client_secret_post' | 'client_secret_basic';
}

export interface McpOAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  /** Milliseconds since 1970, or null when the server did not say. */
  expiresAt: number | null;
}

function httpsUrl(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url : null;
  } catch { return null; }
}

async function getJson(url: string, opts: McpNetOptions): Promise<Record<string, unknown> | null> {
  let opened;
  try {
    opened = await mcpOpen(url, { method: 'GET', headers: { accept: 'application/json', 'user-agent': 'josi-ce' } }, opts);
  } catch (err) {
    // A private or unreachable address is a refusal the caller must see; a
    // missing document is only "try the next address".
    if (err instanceof McpError && err.category === 'network') throw err;
    return null;
  }
  try {
    if (opened.res.status !== 200) { await opened.res.body?.cancel().catch(() => undefined); return null; }
    const parsed: unknown = JSON.parse(await readMcpBody(opened.res, MAX_METADATA_BYTES));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  } finally {
    await opened.finish();
  }
}

/** `resource_metadata="..."` and `scope="..."` from a WWW-Authenticate header. */
export function parseWwwAuthenticate(header: string | null): { resourceMetadata: string | null; scope: string | null } {
  const pick = (name: string): string | null => {
    const match = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^\\s,]+))`, 'i').exec(header ?? '');
    return match ? (match[1] ?? match[2] ?? null) : null;
  };
  return { resourceMetadata: pick('resource_metadata'), scope: pick('scope') };
}

const scopeList = (raw: unknown): string[] => {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s+/) : [];
  return list.filter((s): s is string => typeof s === 'string' && /^[\x21\x23-\x5b\x5d-\x7e]{1,200}$/.test(s)).slice(0, 50);
};

const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** Steps 1 and 2: from a server address (and the 401 it answered with) to the
 * addresses sign-in needs. */
export async function discoverMcpOAuth(
  serverUrl: string,
  wwwAuthenticate: string | null,
  opts: McpNetOptions = {},
): Promise<McpOAuthMetadata> {
  const server = httpsUrl(serverUrl);
  if (!server) throw new McpError('that is not a valid https address', { category: 'provider_error' });
  const challenge = parseWwwAuthenticate(wwwAuthenticate);
  const path = server.pathname.replace(/\/+$/, '');

  // 1. The protected-resource document: where the header points, then the two
  //    well-known addresses.
  const resourceCandidates = [
    httpsUrl(challenge.resourceMetadata)?.toString(),
    path ? `${server.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ].filter((v): v is string => !!v);
  let resourceDoc: Record<string, unknown> | null = null;
  for (const candidate of [...new Set(resourceCandidates)]) {
    resourceDoc = await getJson(candidate, opts);
    if (resourceDoc) break;
  }
  const issuers = (Array.isArray(resourceDoc?.authorization_servers) ? resourceDoc!.authorization_servers : [])
    .map((v) => httpsUrl(v)).filter((v): v is URL => !!v);
  // An older server publishes no such document and is its own sign-in server.
  const issuer = issuers[0] ?? new URL(server.origin);
  const issuerPath = issuer.pathname.replace(/\/+$/, '');

  // 2. The authorization server's own description.
  const metadataCandidates = [
    `${issuer.origin}/.well-known/oauth-authorization-server${issuerPath}`,
    `${issuer.origin}/.well-known/openid-configuration${issuerPath}`,
    issuerPath ? `${issuer.origin}${issuerPath}/.well-known/openid-configuration` : null,
  ].filter((v): v is string => !!v);
  let doc: Record<string, unknown> | null = null;
  for (const candidate of metadataCandidates) {
    doc = await getJson(candidate, opts);
    if (doc) break;
  }
  if (!doc) {
    throw new McpError(
      `${server.hostname} asked for a sign-in but does not say where to sign in, so Josi cannot open one. `
      + 'If it gave you a token, choose "A token" instead.',
      { category: 'provider_error' },
    );
  }
  const authorization = httpsUrl(doc.authorization_endpoint);
  const token = httpsUrl(doc.token_endpoint);
  if (!authorization || !token) {
    throw new McpError(`${issuer.hostname} did not publish usable sign-in addresses`, { category: 'provider_error' });
  }
  // RFC 8414: the document must be about the issuer that was asked for, or a
  // different server could answer for it.
  if (typeof doc.issuer === 'string' && !sameIssuer(doc.issuer, issuer.toString())) {
    throw new McpError(`${issuer.hostname} published sign-in details for a different server, so Josi refused them`, { category: 'provider_error' });
  }
  const methods = Array.isArray(doc.code_challenge_methods_supported) ? doc.code_challenge_methods_supported : null;
  if (methods && !methods.includes('S256')) {
    throw new McpError(`${issuer.hostname} does not support the protected sign-in Josi requires (PKCE S256)`, { category: 'provider_error' });
  }
  const registration = httpsUrl(doc.registration_endpoint);
  const scopes = scopeList(challenge.scope).length ? scopeList(challenge.scope)
    : scopeList(resourceDoc?.scopes_supported);
  const declaredResource = httpsUrl(resourceDoc?.resource);
  return {
    // The server's own name for itself when it is on the same host; otherwise
    // the address the person typed. A token asked for one and spent on
    // another is what `resource` exists to prevent.
    resource: declaredResource && declaredResource.hostname === server.hostname ? declaredResource.toString() : `${server.origin}${server.pathname}`,
    issuer: issuer.toString(),
    authorizationEndpoint: authorization.toString(),
    tokenEndpoint: token.toString(),
    registrationEndpoint: registration?.toString() ?? null,
    scopes,
  };
}

async function postJson(
  url: string, headers: Record<string, string>, body: string, opts: McpNetOptions,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const opened = await mcpOpen(url, { method: 'POST', headers: { accept: 'application/json', 'user-agent': 'josi-ce', ...headers }, body }, opts);
  try {
    const text = await readMcpBody(opened.res, MAX_METADATA_BYTES);
    let json: Record<string, unknown> | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch { json = null; }
    return { status: opened.res.status, json };
  } finally {
    await opened.finish();
  }
}

const tokenText = (raw: unknown, max = 8192): string | null =>
  (typeof raw === 'string' && raw.length > 0 && raw.length <= max && !/[\s\u0000-\u001f\u007f]/.test(raw) ? raw : null);

/** Step 3: Josi registers itself with the sign-in server (RFC 7591). */
export async function registerMcpOAuthClient(
  metadata: McpOAuthMetadata,
  args: { redirectUri: string },
  opts: McpNetOptions = {},
): Promise<McpOAuthClient> {
  if (!metadata.registrationEndpoint) {
    throw new McpError('this sign-in server does not let apps register themselves', { category: 'provider_error' });
  }
  const { status, json } = await postJson(metadata.registrationEndpoint, { 'content-type': 'application/json' }, JSON.stringify({
    client_name: 'Josi',
    redirect_uris: [args.redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(metadata.scopes.length ? { scope: metadata.scopes.join(' ') } : {}),
  }), opts);
  const clientId = tokenText(json?.client_id, 512);
  if (status >= 400 || !clientId) {
    throw new McpError(
      'the sign-in server would not register Josi. If it gave you a client id, paste it and try again.',
      { category: 'provider_error', status },
    );
  }
  const clientSecret = tokenText(json?.client_secret, 2048);
  const method = json?.token_endpoint_auth_method;
  return {
    clientId, clientSecret,
    tokenAuth: !clientSecret ? 'none' : method === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post',
  };
}

/** RFC 7636 S256. */
export function createMcpPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

/** Step 4: the address the person's browser is sent to. */
export function buildMcpAuthorizationUrl(
  metadata: McpOAuthMetadata,
  args: { clientId: string; redirectUri: string; state: string; challenge: string },
): string {
  const url = new URL(metadata.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', args.clientId);
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('state', args.state);
  url.searchParams.set('code_challenge', args.challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('resource', metadata.resource);
  if (metadata.scopes.length) url.searchParams.set('scope', metadata.scopes.join(' '));
  return url.toString();
}

async function tokenRequest(
  metadata: McpOAuthMetadata, client: McpOAuthClient, form: Record<string, string>, opts: McpNetOptions,
): Promise<McpOAuthTokens> {
  const body = new URLSearchParams({ ...form, client_id: client.clientId, resource: metadata.resource });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (client.clientSecret && client.tokenAuth === 'client_secret_basic') {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`, 'utf8').toString('base64')}`;
  } else if (client.clientSecret) {
    body.set('client_secret', client.clientSecret);
  }
  const { status, json } = await postJson(metadata.tokenEndpoint, headers, body.toString(), opts);
  const accessToken = tokenText(json?.access_token);
  const kind = typeof json?.token_type === 'string' ? json.token_type.toLowerCase() : 'bearer';
  if (status >= 400 || !accessToken || kind !== 'bearer') {
    // `invalid_grant` is the sign-in server saying the code or the refresh
    // token is spent. A category, never its description text.
    const revoked = json?.error === 'invalid_grant' || json?.error === 'invalid_client' || status === 401;
    throw new McpError(
      revoked ? 'the sign-in is no longer accepted. Sign in again.' : 'the sign-in server did not complete the sign-in',
      { category: revoked ? 'revoked' : 'provider_error', status, unauthorized: revoked },
    );
  }
  const seconds = typeof json?.expires_in === 'number' && Number.isFinite(json.expires_in) && json.expires_in > 0
    ? Math.min(json.expires_in, 366 * 24 * 3600) : null;
  return {
    accessToken,
    refreshToken: tokenText(json?.refresh_token),
    expiresAt: seconds === null ? null : Date.now() + seconds * 1000,
  };
}

/** Step 5: the code the browser came back with, exchanged once. */
export function exchangeMcpOAuthCode(
  metadata: McpOAuthMetadata, client: McpOAuthClient,
  args: { code: string; verifier: string; redirectUri: string }, opts: McpNetOptions = {},
): Promise<McpOAuthTokens> {
  return tokenRequest(metadata, client, {
    grant_type: 'authorization_code', code: args.code, code_verifier: args.verifier, redirect_uri: args.redirectUri,
  }, opts);
}

/** A new access token from the refresh token. The old refresh token is kept
 * when the server does not issue a new one. */
export async function refreshMcpOAuthTokens(
  metadata: McpOAuthMetadata, client: McpOAuthClient, refreshToken: string, opts: McpNetOptions = {},
): Promise<McpOAuthTokens> {
  const tokens = await tokenRequest(metadata, client, { grant_type: 'refresh_token', refresh_token: refreshToken }, opts);
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

/** For the settings page: the sign-in server's name, cleaned. */
export function mcpIssuerLabel(issuer: string): string {
  try { return cleanMcpLine(new URL(issuer).hostname, 120); } catch { return ''; }
}
