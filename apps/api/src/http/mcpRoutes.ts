// Custom MCP servers over HTTP.
//
// An MCP server is an outside web address that offers Josi a list of tools.
// Each person adds their own, with their own sign-in.
//
//   MEMBER — /connections/mcp
//     GET    /                         what I may do, and my servers
//     POST   /                         add one (connects and lists tools first)
//     PATCH  /:id                      rename, switch on/off, switch tools off
//     POST   /:id/check                ask the server again
//     DELETE /:id                      remove it and its sealed sign-in
//     POST   /:id/oauth/start          begin browser sign-in
//     GET    /oauth/callback           where the browser comes back
//     POST   /oauth/complete           the same, for a phone app
//     GET    /pending                  tool calls waiting for me
//     POST   /pending/:id/approve      decide AND run, once
//     POST   /pending/:id/deny
//
//   OWNER — /admin/mcp
//     GET    /policy                   who may add servers, and who has
//     PUT    /policy                   set it
//
// Four claims, each with a test attacking it:
//
//   * NO RESPONSE CONTAINS A CREDENTIAL. A token, a header value, a client
//     secret and OAuth tokens appear only as "set" or "not set".
//   * PERMISSION IS ENFORCED ON THE WRITE. The owner always may; a member only
//     as the policy says. Removing and switching off are always allowed.
//   * A SERVER AND A PENDING CALL BELONG TO ONE PERSON. Somebody else's id is
//     404, exactly like one that never existed. The owner of the installation
//     using these routes is a member like any other.
//   * APPROVING IS RUNNING, EXACTLY ONCE, with exactly the approved arguments.
import { Router, type Request, type Response } from 'express';
import { loadMasterKey, VaultError, VaultLockedError, type Db, type LoadOptions, type MasterKey } from '@josi-ce/core';
import { installationOrigin } from '@josi-ce/agent';
import {
  MAX_MCP_CONNECTIONS_PER_PERSON, McpAccessError, McpCallError, McpError, McpInputError,
  checkMcpConnection, claimApprovedMcpCall, createMcpConnection, deleteMcpConnection, denyMcpCall, finishMcpOAuth,
  listMcpConnections, listPendingMcpCalls, mcpConnectionById, mcpHeadersFor, mcpPendingCallById, mcpPermitted, mcpPolicy,
  openApprovedMcpCall, peekMcpOAuthState, prepareMcpOAuth, probeMcpServer, recordMcpCallResult, requireMcpPermission, runMcpTool,
  setMcpPolicy, startMcpOAuth, summarizeScope, updateMcpConnection,
  validateMcpAuthKind, validateMcpHeaderName, validateMcpHeaderValue, validateMcpName, validateMcpSlug, validateMcpToken, validateMcpUrl,
  type McpConnectionRow, type McpOAuthInfo, type McpToolResult,
} from '@josi-ce/connectors';
import { asyncRoute, param } from './async.js';
import { requireAuth, requireSuperAdmin } from './authz.js';

export interface McpRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** The installation's configured address, for the sign-in return address. */
  appUrl: string;
  /** Injected by the tests. No suite contacts a real server. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the private-address suite. */
  resolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof VaultLockedError) return res.status(423).json({ error: err.message });
      if (err instanceof VaultError) return res.status(409).json({ error: err.message });
      if (err instanceof RouteError || err instanceof McpAccessError) return res.status(err.status).json({ error: err.message });
      if (err instanceof McpInputError) return res.status(400).json({ error: err.message, ...(err.code ? { code: err.code } : {}) });
      if (err instanceof McpCallError) return res.status(err.notFound ? 404 : 409).json({ error: err.message });
      // The server's refusal: a category and a sentence Josi wrote. Never the
      // server's own words.
      if (err instanceof McpError) return res.status(502).json({ error: err.message, category: err.category });
      throw err;
    }
  });

function requireKey(ctx: McpRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try { return loadMasterKey(ctx.masterKey ?? {}); } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable, so nothing can be saved securely.');
  }
}

/** Where a browser sign-in comes back to. */
export async function mcpRedirectUri(ctx: Pick<McpRoutesCtx, 'db' | 'appUrl'>): Promise<string> {
  const { origin } = await installationOrigin(ctx.db, ctx.appUrl.replace(/\/$/, ''));
  return `${origin}/api/connections/mcp/oauth/callback`;
}

/** What a person sees about one of their own servers. No credential, no
 * sealed reference, no endpoint a browser could be sent to. */
function connectionView(row: McpConnectionRow) {
  const off = new Set(row.disabled_tools);
  const oauth = row.auth_kind === 'oauth' ? row.oauth as Partial<McpOAuthInfo> : null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    url: row.url,
    host: row.host,
    auth: row.auth_kind,
    headerName: row.auth_header,
    // Whether a sealed sign-in is held. Never its value, length or ending.
    credentialSet: !!row.credentials_enc,
    oauth: oauth ? {
      signInServer: (() => { try { return new URL(oauth.issuer ?? '').hostname; } catch { return null; } })(),
      signedIn: oauth.signedIn === true,
      expiresAt: typeof oauth.expiresAt === 'number' ? new Date(oauth.expiresAt).toISOString() : null,
    } : null,
    status: row.status,
    enabled: row.enabled,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
    lastError: row.last_error,
    serverName: row.server_name,
    toolsFetchedAt: row.tools_fetched_at,
    toolsLeftOut: row.tools_dropped,
    tools: (row.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description,
      // What the server says now, and what Josi does. They differ when a tool
      // that used to ask is now labelled read-only: it keeps asking until the
      // person checks the connection here.
      readOnly: tool.readOnly,
      asksFirst: tool.asks,
      enabled: !off.has(tool.name),
    })),
  };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function resultView(result: McpToolResult) {
  return { text: result.text, toolReportedError: result.isError, truncated: result.truncated, leftOut: result.dropped };
}

// ---------------------------------------------------------------- the member

export function mcpRoutes(ctx: McpRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  const net = { fetchImpl: ctx.fetchImpl, resolve: ctx.resolve };

  /**
   * Where the browser comes back after sign-in. The one route here that does
   * not demand a session up front, because it has to answer a browser with a
   * page rather than a 401 — but it finishes nothing without one, except to
   * pass a phone app's sign-in back to the app, which then finishes it with
   * its own session.
   */
  r.get('/oauth/callback', handle(async (req, res) => {
    const state = req.query.state;
    const back = (reason: string) => res.redirect(`/app/connections?mcp_error=${encodeURIComponent(reason)}`);
    const pending = await peekMcpOAuthState(db, state);
    if (!pending) return back('expired');
    if (!req.user) {
      if (!pending.native) return back('session');
      // Nothing is redeemed here: the state and code go to the app, and who is
      // signing in stays in the stored state. The verifier never leaves.
      const app = new URL('josi://connections/mcp/callback');
      app.searchParams.set('state', String(state));
      if (typeof req.query.code === 'string') app.searchParams.set('code', req.query.code);
      if (typeof req.query.error === 'string') app.searchParams.set('error', 'declined');
      return res.redirect(app.toString());
    }
    const done = await finishMcpOAuth(db, requireKey(ctx), {
      state, code: req.query.code, userId: req.user.id, declined: typeof req.query.error === 'string',
    }, net);
    return done.ok ? res.redirect('/app/connections?mcp=connected') : back(done.reason);
  }));

  r.use(requireAuth);

  /** A phone app finishing the sign-in its own browser sheet started. */
  r.post('/oauth/complete', handle(async (req, res) => {
    const done = await finishMcpOAuth(db, requireKey(ctx), {
      state: req.body?.state, code: req.body?.code, userId: req.user!.id, declined: req.body?.error !== undefined && req.body?.error !== null,
    }, net);
    if (!done.ok) throw new RouteError(done.reason === 'wrong_person' || done.reason === 'unknown' ? 404 : 409, signInSentence(done.reason));
    return res.json({ ok: true, connection: connectionView(done.connection) });
  }));

  /** Whether I may add servers, and the ones I have. */
  r.get('/', handle(async (req, res) => {
    const policy = await mcpPolicy(db);
    return res.json({
      allowed: await mcpPermitted(db, req.user!.id),
      // The owner's own words when they refused it.
      note: policy.note,
      maxConnections: MAX_MCP_CONNECTIONS_PER_PERSON,
      // What to give a server that asks for a return address when you
      // register an app with it by hand.
      redirectUri: await mcpRedirectUri(ctx),
      connections: (await listMcpConnections(db, req.user!.id)).map(connectionView),
    });
  }));

  /**
   * Add a server.
   *
   * For "no sign-in", a token or a named header, the server is contacted and
   * asked for its tools BEFORE anything is stored: an address that does not
   * work is never saved as though it did. For browser sign-in the server is
   * asked where to sign in, Josi registers itself there (or uses the client id
   * you paste), and the reply says a sign-in is needed.
   */
  r.post('/', handle(async (req, res) => {
    const userId = req.user!.id;
    await requireMcpPermission(db, userId);
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = validateMcpName(body.name);
    const slugExplicit = !!str(body.slug).trim();
    const slug = validateMcpSlug(body.slug, name);
    const { url, host } = validateMcpUrl(body.url);
    const authKind = validateMcpAuthKind(body.auth);
    const key = requireKey(ctx);

    if (authKind === 'oauth') {
      const prepared = await prepareMcpOAuth(url, {
        redirectUri: await mcpRedirectUri(ctx),
        clientId: str(body.clientId).trim() || null, clientSecret: str(body.clientSecret).trim() || null,
      }, net);
      const row = await createMcpConnection(db, key, {
        ownerUserId: userId, name, slug, slugExplicit, url, host, authKind, authHeader: null,
        secret: prepared.clientSecret ? { clientSecret: prepared.clientSecret } : null, oauth: prepared.info,
      });
      return res.status(201).json({ ok: true, signInNeeded: true, connection: connectionView(row) });
    }

    const authHeader = authKind === 'header' ? validateMcpHeaderName(body.headerName) : null;
    const secret = authKind === 'bearer' ? { token: validateMcpToken(body.token) }
      : authKind === 'header' ? { value: validateMcpHeaderValue(body.headerValue) } : null;
    let probe;
    try {
      probe = await probeMcpServer({ url, authHeaders: mcpHeadersFor(authKind, authHeader, secret ?? {}) }, net);
    } catch (err) {
      if (err instanceof McpError && err.unauthorized) {
        throw new RouteError(400, authKind === 'none'
          ? `${host} asked for a sign-in. Choose how to sign in and try again.`
          : `${host} did not accept that sign-in. Check the value and try again.`);
      }
      throw err;
    }
    const row = await createMcpConnection(db, key, {
      ownerUserId: userId, name, slug, slugExplicit, url, host, authKind, authHeader, secret, probe,
    });
    return res.status(201).json({ ok: true, signInNeeded: false, connection: connectionView(row) });
  }));

  /** Mine and only mine. */
  r.get('/pending', handle(async (req, res) => {
    const rows = await listPendingMcpCalls(db, req.user!.id);
    return res.json({
      pending: rows.map((row) => ({
        id: row.id,
        connectionName: row.connection_name,
        host: row.host,
        tool: row.tool_name,
        // What would happen, in words, before anybody agrees to it.
        summary: row.summary,
        requestedAt: row.created_at,
        expiresAt: row.expires_at,
      })),
    });
  }));

  /**
   * Approve, and run — one route. The claim is a single conditional UPDATE, so
   * two taps produce one call and one 409. What is sent is the SEALED call,
   * re-hashed: the tool and arguments that were described, or nothing.
   */
  r.post('/pending/:id/approve', handle(async (req, res) => {
    const userId = req.user!.id;
    const key = requireKey(ctx);
    const pending = await mcpPendingCallById(db, param(req, 'id'));
    if (!pending || pending.owner_user_id !== userId) throw new McpCallError('there is no request with that id', true);
    // Checked BEFORE the claim so a refusal here does not use the request up.
    await requireMcpPermission(db, userId);
    const call = await claimApprovedMcpCall(db, { callId: pending.id, decidedBy: userId });
    const connection = await mcpConnectionById(db, userId, call.connection_id);
    const fail = async (message: string): Promise<never> => {
      await recordMcpCallResult(db, key, { callId: call.id, ownerUserId: userId, slug: connection?.slug ?? 'unknown', tool: call.tool_name, ok: false });
      throw new RouteError(409, message);
    };
    if (!connection) return fail('that server was removed, so Josi did not run the tool');
    let sealed;
    try { sealed = openApprovedMcpCall(key, call); } catch (err) {
      await recordMcpCallResult(db, key, { callId: call.id, ownerUserId: userId, slug: connection.slug, tool: call.tool_name, ok: false });
      throw err;
    }
    // Everything is checked AGAIN. A server switched off, pointed elsewhere or
    // stripped of this tool while the request waited is not what was approved.
    if (!connection.enabled) return fail('that server was switched off while this was waiting, so Josi did not run the tool');
    if (connection.url !== sealed.url) return fail('that server\'s address changed while this was waiting, so Josi did not run the tool');
    const tool = (connection.tools ?? []).find((t) => t.name === sealed.tool);
    if (!tool || connection.disabled_tools.includes(sealed.tool)) return fail('that tool is no longer available on that server, so Josi did not run it');

    try {
      const result = await runMcpTool(db, key, connection, sealed.tool, sealed.arguments, net);
      await recordMcpCallResult(db, key, { callId: call.id, ownerUserId: userId, slug: connection.slug, tool: sealed.tool, ok: !result.isError, result });
      // The answer goes to the person who authorised the call. It is theirs;
      // it is not written to a log or an audit record.
      return res.json({ ok: !result.isError, result: resultView(result) });
    } catch (err) {
      await recordMcpCallResult(db, key, { callId: call.id, ownerUserId: userId, slug: connection.slug, tool: sealed.tool, ok: false });
      throw err;
    }
  }));

  r.post('/pending/:id/deny', handle(async (req, res) => {
    const row = await denyMcpCall(db, { callId: param(req, 'id'), decidedBy: req.user!.id });
    return res.json({ ok: true, status: row.status });
  }));

  const mine = async (req: Request): Promise<McpConnectionRow> => {
    const row = await mcpConnectionById(db, req.user!.id, param(req, 'id'));
    if (!row) throw new RouteError(404, 'there is no such server');
    return row;
  };

  /** Rename, switch on or off, or switch single tools off. */
  r.patch('/:id', handle(async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const row = await updateMcpConnection(db, {
      ownerUserId: req.user!.id, id: (await mine(req)).id,
      ...(body.name !== undefined ? { name: validateMcpName(body.name) } : {}),
      ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
      ...(Array.isArray(body.disabledTools) ? { disabledTools: body.disabledTools.filter((v): v is string => typeof v === 'string') } : {}),
    });
    return res.json({ ok: true, connection: connectionView(row) });
  }));

  /**
   * Ask the server again, from the settings page. This is the person looking
   * for themselves, so the tool list is taken as the server declares it —
   * including a tool that is now read-only and used to ask.
   */
  r.post('/:id/check', handle(async (req, res) => {
    const row = await mine(req);
    try {
      const checked = await checkMcpConnection(db, requireKey(ctx), row, net, { trusted: true });
      return res.json({ ok: true, detail: `${checked.name} answered and offers ${checked.tools.length} tool${checked.tools.length === 1 ? '' : 's'}.`, connection: connectionView(checked) });
    } catch (err) {
      if (!(err instanceof McpError)) throw err;
      // A failed check is an answer, not an error: the page shows what is wrong.
      const current = await mcpConnectionById(db, req.user!.id, row.id);
      return res.json({ ok: false, detail: err.message, connection: connectionView(current ?? row) });
    }
  }));

  /** Begin browser sign-in. Returns the address to open. */
  r.post('/:id/oauth/start', handle(async (req, res) => {
    const row = await mine(req);
    const started = await startMcpOAuth(db, requireKey(ctx), { userId: req.user!.id, connectionId: row.id, native: req.body?.native === true });
    return res.json({ ok: true, authorizationUrl: started.authorizationUrl });
  }));

  /** Remove it. The sealed sign-in goes with it. */
  r.delete('/:id', handle(async (req, res) => {
    if (!(await deleteMcpConnection(db, req.user!.id, param(req, 'id')))) throw new RouteError(404, 'there is no such server');
    return res.status(204).end();
  }));

  return r;
}

function signInSentence(reason: string): string {
  switch (reason) {
    case 'declined': return 'The sign-in was cancelled, so nothing was connected.';
    case 'consumed': case 'expired': case 'unknown': return 'That sign-in had already been used or had expired. Start again.';
    case 'wrong_person': return 'That sign-in was started by a different account.';
    default: return 'The sign-in could not be completed. Please try again.';
  }
}

// ----------------------------------------------------------------- the owner

export function adminMcpRoutes(ctx: Pick<McpRoutesCtx, 'db'>): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** Who may add MCP servers, and — separately — who has. No credential, no
   * tool list and no address path: a name, a host and whether it works. */
  r.get('/policy', handle(async (_req, res) => {
    const policy = await mcpPolicy(db);
    const people = await db.query<{ id: string; username: string; email: string }>(
      `select id, username, email from users where role in ('member', 'super_admin') order by username`);
    const nameById = new Map(people.map((p) => [p.id, p.username]));
    const connections = await db.query<{
      owner_user_id: string; username: string; name: string; host: string; status: string; enabled: boolean;
      last_check_at: string | null; last_check_ok: boolean | null;
    }>(
      `select c.owner_user_id, u.username, c.name, c.host, c.status, c.enabled, c.last_check_at, c.last_check_ok
         from mcp_connections c join users u on u.id = c.owner_user_id order by u.username, c.created_at`);
    return res.json({
      mode: policy.mode,
      note: policy.note,
      allowedUserIds: policy.allowedUserIds,
      allowManagedChildren: policy.allowManagedChildren,
      summary: summarizeScope({ mode: policy.mode, allowedUserIds: policy.allowedUserIds }, policy.allowedUserIds.map((id) => nameById.get(id) ?? 'someone removed')),
      people: people.map((p) => ({ id: p.id, username: p.username, email: p.email })),
      connections: connections.map((c) => ({
        userId: c.owner_user_id, username: c.username, name: c.name, host: c.host, status: c.status, enabled: c.enabled,
        lastCheckAt: c.last_check_at, lastCheckOk: c.last_check_ok,
      })),
    });
  }));

  /** Set who may. Un-naming somebody does not delete what they connected: it
   * stops Josi using it, and removing it stays theirs to do. */
  r.put('/policy', handle(async (req, res) => {
    const policy = await setMcpPolicy(db, { actorUserId: req.user!.id, mode: req.body?.mode, note: req.body?.note, userIds: req.body?.userIds,
      allowManagedChildren: req.body?.allowManagedChildren });
    return res.json({ ok: true, mode: policy.mode, note: policy.note, allowedUserIds: policy.allowedUserIds, allowManagedChildren: policy.allowManagedChildren });
  }));

  return r;
}
