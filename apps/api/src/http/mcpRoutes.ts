// External MCP server connections over HTTP.
//
// The whole surface, and who may reach it:
//
//   OWNER — connects their own servers and decides what Josi may run on them.
//     GET    /mcp-servers                       mine, masked, with the ceiling
//     POST   /mcp-servers                       add one; arrives off and untested
//     PATCH  /mcp-servers/:id                   edit; resets verification
//     POST   /mcp-servers/:id/connect           handshake AND discover tools
//     POST   /mcp-servers/:id/enable | /disable needs a successful handshake
//     DELETE /mcp-servers/:id
//     POST   /mcp-servers/tools/:toolId/approve one tool, having read it
//     POST   /mcp-servers/tools/:toolId/revoke
//     GET    /mcp-servers/pending               my waiting calls
//     POST   /mcp-servers/pending/:id/approve   decide AND run, once
//     POST   /mcp-servers/pending/:id/deny
//
//   ADMINISTRATOR — sets the ceiling and can cut a connection off. Never sees
//   what somebody connected to or approved.
//     GET    /admin/mcp-servers                 health and the ceiling
//     PUT    /admin/mcp-servers/policy          deny-only
//     DELETE /admin/mcp-servers/connections/:id cut one off
//
// Five claims, each with a test attacking it:
//
//   * NO RESPONSE FROM THIS FILE CONTAINS A CREDENTIAL. Not the plaintext, not
//     the ciphertext, not a prefix, not a length. `CREDENTIAL_MASK` is a
//     constant, and every administrator DTO goes through `assertMetadataOnly`.
//   * A SERVER BELONGS TO ONE PERSON. Another member's id is 404 — not 403,
//     which would confirm it exists. There is no share, no workspace
//     visibility, and no administrator read of what is inside.
//   * NOTHING REACHES THE ASSISTANT ON THE STRENGTH OF A FORM. A server cannot
//     be enabled until it has completed a handshake, and every tool under it is
//     separately at `new` until its owner reads it and approves it.
//   * APPROVING A TOOL PINS WHAT WAS READ. The digest the page showed travels
//     with the decision; a server that changed the tool in between is refused.
//   * APPROVING A CALL IS RUNNING IT, EXACTLY ONCE. The decision and the call
//     are one route and one conditional UPDATE.
import { Router, type Request, type Response } from 'express';
import { appendEvent, loadMasterKey, type Db, type LoadOptions, type MasterKey } from '@josi-ce/core';
import {
  CREDENTIAL_MASK,
  MAX_MCP_SERVERS_PER_USER, McpCallError, McpError, McpInputError,
  claimApprovedMcpCall, closeMcpSession, createMcpServer, deleteMcpServer, denyMcpCall,
  disableMcpServer, enableMcpServer, listMcpServers, listMcpTools, listPendingMcpCalls,
  mcpListTools, mcpPolicy, mcpServerById, mcpToolById, openApprovedMcpRequest, openMcpCredentials,
  openMcpSession, policyRefusal, recordMcpCallResult, recordMcpCheck, reconcileMcpTools,
  resolveMcpTool, setMcpPolicy, setMcpToolDecision, updateMcpServer, validateMcpAllowedHosts,
  validateMcpAuthHeader, validateMcpAuthKind, validateMcpCredentials, validateMcpEndpointUrl,
  validateMcpName, validateMcpSlug,
  type McpApprovalMode, type McpServerRow, type McpToolRow,
} from '@josi-ce/connectors';
import { runMcpToolNow } from '@josi-ce/agent';
import { asyncRoute, param } from './async.js';
import { assertMetadataOnly, requireAuth, requireSuperAdmin } from './authz.js';

export interface McpRoutesCtx {
  db: Db;
  masterKey?: LoadOptions | false;
  /** Injected by the tests. No suite contacts a real MCP server. */
  fetchImpl?: typeof fetch;
  /** Injected by the tests, and by the SSRF suite to answer with a hostile
   * address. Unset in production, where the host's own resolver is used. */
  resolve?: (hostname: string) => Promise<string[]>;
}

class RouteError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const handle = (fn: (req: Request, res: Response) => Promise<unknown>) =>
  asyncRoute(async (req: Request, res: Response) => {
    try {
      return await fn(req, res);
    } catch (err: unknown) {
      if (err instanceof RouteError) return res.status(err.status).json({ error: err.message });
      if (err instanceof McpInputError) return res.status(400).json({ error: err.message });
      // A pending call that is not yours reads exactly like one that never
      // existed. Anything else about one — already decided, expired — is a
      // conflict, because the row is real and the caller owns it.
      if (err instanceof McpCallError) {
        return res.status(err.notFound ? 404 : 409).json({ error: err.message });
      }
      // A server's refusal is a 502 with a category: the request was fine, the
      // answer was not. The message is one CE wrote — never the server's.
      if (err instanceof McpError) {
        return res.status(502).json({ error: err.message, category: err.category });
      }
      throw err;
    }
  });

function requireKey(ctx: McpRoutesCtx): MasterKey {
  if (ctx.masterKey === false) throw new RouteError(503, 'this installation cannot store secrets right now');
  try {
    return loadMasterKey(ctx.masterKey ?? {});
  } catch {
    throw new RouteError(503, 'the installation master key is missing or unusable');
  }
}

/** The ceiling, applied.
 *
 * Checked on every route that CONTACTS a server, not only on the one that
 * stores it. Listing, disabling and removing stay available on purpose: a
 * ceiling must never trap somebody's live token inside Josi with no way to take
 * it back.
 */
async function assertAllowed(db: Db, host: string): Promise<void> {
  const refusal = policyRefusal(await mcpPolicy(db), host);
  if (refusal) throw new RouteError(403, refusal);
}

// -------------------------------------------------------------------- views

/**
 * What the OWNER sees about their own server.
 *
 * `credentialMask` is a constant — not the last four characters and not the
 * length. A mask derived from the secret is still made of the secret, and
 * "which credential is this?" is answered by the name they typed.
 */
function serverView(row: McpServerRow, tools: McpToolRow[]) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    endpointUrl: row.endpoint_url,
    host: row.host,
    authKind: row.auth_kind,
    authHeader: row.auth_header,
    hasCredential: !!row.credentials_enc,
    credentialMask: row.credentials_enc ? CREDENTIAL_MASK : null,
    enabled: row.enabled,
    serverStatus: row.status,
    lastCheckAt: row.last_check_at,
    lastCheckOk: row.last_check_ok,
    lastErrorCategory: row.last_error_category,
    protocolVersion: row.protocol_version,
    serverLabel: row.server_label,
    lastDiscoveryAt: row.last_discovery_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tools: tools.map(toolView),
  };
}

function toolView(row: McpToolRow) {
  return {
    id: row.id,
    serverId: row.server_id,
    name: row.tool_name,
    title: row.title,
    // The remote server's own words, shown as such. The page labels them.
    description: row.description,
    inputSchema: row.input_schema ?? {},
    serverClaimsReadOnly: row.server_read_only_hint,
    toolState: row.state,
    approvalMode: row.approval_mode,
    available: row.available,
    // Travels to the browser and back with an approval, so the decision lands
    // on the exact words that were on the screen.
    digest: row.definition_digest,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/** What the SUPER ADMIN sees about somebody else's: whose it is, which host it
 * reaches, and whether it works.
 *
 * THE HOST IS INCLUDED, and that is a deliberate departure from the developer
 * services, where the administrator sees no account identifier at all. There
 * the host was pinned in CE's own source and already known; here it is
 * user-supplied, it is an outbound destination from the operator's own server,
 * and the ceiling below is expressed in hosts — an allowlist an administrator
 * cannot see the candidates for is an allowlist nobody can write. The cost is
 * real and is stated on the owner's own page rather than left as a surprise.
 *
 * Not included: the name they typed, the short name, the full endpoint address,
 * what the server calls itself, and every tool — its name, its description, its
 * schema and whether it was approved. `assertMetadataOnly` is the backstop.
 */
function adminServerView(row: McpServerRow & { username?: string; approved_tools?: number }) {
  const dto = {
    id: row.id,
    owner_user_id: row.owner_user_id,
    username: row.username ?? null,
    host: row.host,
    enabled: row.enabled,
    status: row.status,
    last_check_at: row.last_check_at,
    last_check_ok: row.last_check_ok,
    last_error_category: row.last_error_category,
    approved_tools: Number(row.approved_tools ?? 0),
    created_at: row.created_at,
  };
  assertMetadataOnly(dto);
  return dto;
}

// -------------------------------------------------------------- the request

function readServerForm(body: Record<string, unknown>, existing?: McpServerRow) {
  const name = body.name !== undefined || !existing
    ? validateMcpName(body.name)
    : existing.name;

  const endpoint = body.endpointUrl !== undefined || !existing
    ? validateMcpEndpointUrl(body.endpointUrl)
    : { endpointUrl: existing.endpoint_url, host: existing.host };

  const authKind = body.authKind !== undefined || !existing
    ? validateMcpAuthKind(body.authKind)
    : existing.auth_kind;

  const authHeader = authKind === 'api_key'
    ? (body.authHeader !== undefined || !existing || existing.auth_kind !== 'api_key'
      ? validateMcpAuthHeader(body.authHeader)
      : existing.auth_header)
    : null;

  // A blank secret on an edit means "leave it alone", which is the only way a
  // form can offer a masked field without making the mask re-submittable.
  const wantsCredential = !existing || authKind !== existing.auth_kind
    || (typeof body.secret === 'string' && body.secret.trim() !== '');
  const credentials = wantsCredential
    ? validateMcpCredentials(authKind, { secret: body.secret })
    : undefined;

  return { name, endpoint, authKind, authHeader, credentials };
}

function approvalModeOf(raw: unknown): McpApprovalMode {
  if (raw === 'auto') return 'auto';
  if (raw === 'ask' || raw === undefined || raw === null) return 'ask';
  throw new McpInputError('choose whether Josi may run this on its own or should ask you first');
}

// ------------------------------------------------------------------- owner

export function mcpRoutes(ctx: McpRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireAuth);

  /** Ownership, resolved from the row rather than from the request.
   *
   * A row that belongs to somebody else and a row that does not exist produce
   * the same 404. There is no role branch here on purpose: an administrator
   * using a member route is a member. */
  async function ownedOr404(req: Request, id: string): Promise<McpServerRow> {
    const row = await mcpServerById(db, id);
    if (!row || row.owner_user_id !== req.user!.id) throw new RouteError(404, 'not found');
    return row;
  }

  async function ownedToolOr404(req: Request, id: string): Promise<{ server: McpServerRow; tool: McpToolRow }> {
    const tool = await mcpToolById(db, id);
    if (!tool) throw new RouteError(404, 'not found');
    const server = await ownedOr404(req, tool.server_id);
    return { server, tool };
  }

  /** Everything I have connected, and what an administrator has allowed.
   *
   * Mine and only mine: the query is by `owner_user_id`, so there is no id for
   * a caller to substitute. */
  r.get(
    '/',
    handle(async (req, res) => {
      const servers = await listMcpServers(db, req.user!.id);
      const policy = await mcpPolicy(db);
      const out = [];
      for (const server of servers) {
        out.push(serverView(server, await listMcpTools(db, server.id)));
      }
      return res.json({
        servers: out,
        limit: MAX_MCP_SERVERS_PER_USER,
        policy: {
          // Deny-only, and named so: `allowed` false means an administrator
          // forbade it, never that anything was switched on.
          allowed: policy.allowed,
          note: policy.allowed ? null : policy.note,
          allowedHosts: policy.allowedHosts,
        },
      });
    }),
  );

  /**
   * Add a server. It arrives DISABLED and UNVERIFIED, always.
   *
   * Nothing is contacted here, unlike the developer services, and the
   * difference is worth stating. There, a pasted token is verified before a row
   * exists because the ONLY thing that row holds is the token. Here the row
   * also holds an address somebody may have mistyped and a tool list that does
   * not exist yet, so saving first and connecting second means a wrong address
   * can be corrected rather than retyped from scratch — and the row still
   * grants nothing until `/connect` succeeds and `/enable` is pressed.
   */
  r.post(
    '/',
    handle(async (req, res) => {
      const key = requireKey(ctx);
      const body = (req.body ?? {}) as Record<string, unknown>;
      const form = readServerForm(body);
      const slug = validateMcpSlug(body.slug, form.name);
      await assertAllowed(db, form.endpoint.host);

      const existing = await listMcpServers(db, req.user!.id);
      if (existing.length >= MAX_MCP_SERVERS_PER_USER) {
        throw new RouteError(
          409,
          `you can connect up to ${MAX_MCP_SERVERS_PER_USER} MCP servers. Remove one you no longer use first.`,
        );
      }
      if (existing.some((s) => s.slug === slug)) {
        throw new RouteError(409, `you already have a server with the short name "${slug}"`);
      }

      const row = await createMcpServer(db, key, {
        ownerUserId: req.user!.id,
        name: form.name,
        slug,
        endpointUrl: form.endpoint.endpointUrl,
        host: form.endpoint.host,
        authKind: form.authKind,
        authHeader: form.authHeader,
        credentials: form.credentials ?? null,
      });
      return res.status(201).json({
        server: serverView(row, []),
        note: 'Saved, switched off and not yet contacted. Press Connect to check it and see what '
          + 'tools it offers.',
      });
    }),
  );

  r.patch(
    '/:id',
    handle(async (req, res) => {
      const key = requireKey(ctx);
      const server = await ownedOr404(req, param(req, 'id'));
      const form = readServerForm((req.body ?? {}) as Record<string, unknown>, server);
      if (form.endpoint.host !== server.host) await assertAllowed(db, form.endpoint.host);

      const row = await updateMcpServer(db, key, {
        actorUserId: req.user!.id,
        server,
        name: form.name,
        endpointUrl: form.endpoint.endpointUrl,
        host: form.endpoint.host,
        authKind: form.authKind,
        authHeader: form.authHeader,
        credentials: form.credentials,
      });
      return res.json({
        server: serverView(row, await listMcpTools(db, row.id)),
        note: row.status === 'unverified'
          ? 'Changing where or how Josi connects switches this off again and clears the check, so '
            + 'nothing runs against an address nobody has tested.'
          : undefined,
      });
    }),
  );

  /**
   * Connect: the handshake AND the tool list, in one route.
   *
   * One route rather than two because they answer one question — "is this a
   * working MCP server, and what does it say it offers?" — and a person who
   * connected successfully but had not pressed a second button would be looking
   * at a server with no tools and no explanation.
   *
   * Discovery WRITES ROWS AND GRANTS NOTHING. Everything new arrives at `new`,
   * and anything previously approved whose definition changed is taken off the
   * allowlist and named back to the owner.
   */
  r.post(
    '/:id/connect',
    handle(async (req, res) => {
      const key = requireKey(ctx);
      const server = await ownedOr404(req, param(req, 'id'));
      await assertAllowed(db, server.host);

      let session;
      try {
        session = await openMcpSession(
          { server, secret: openMcpCredentials(key, server) },
          { fetchImpl: ctx.fetchImpl, resolve: ctx.resolve },
        );
      } catch (err) {
        const category = err instanceof McpError ? err.category : 'provider_error';
        await recordMcpCheck(db, { serverId: server.id, ok: false, category });
        await appendEvent(db, {
          actorUserId: req.user!.id,
          actor: 'user',
          kind: 'mcp.server_checked',
          subjectType: 'mcp_server',
          subjectId: server.id,
          // A category, never the server's words and never the credential.
          payload: { slug: server.slug, ok: false, category },
        });
        throw err;
      }

      try {
        // A server that declares no `tools` capability has nothing this feature
        // can use. Recorded as a successful handshake, because it was one, and
        // said plainly rather than shown as an empty list somebody reads as a
        // failure.
        const tools = session.offersTools ? await mcpListTools(session) : [];
        const outcome = await reconcileMcpTools(db, {
          actorUserId: req.user!.id, server, tools,
        });
        await recordMcpCheck(db, {
          serverId: server.id,
          ok: true,
          protocolVersion: session.protocolVersion,
          serverLabel: session.serverLabel,
        });
        await appendEvent(db, {
          actorUserId: req.user!.id,
          actor: 'user',
          kind: 'mcp.server_checked',
          subjectType: 'mcp_server',
          subjectId: server.id,
          payload: { slug: server.slug, ok: true, offered: outcome.total },
        });

        const fresh = (await mcpServerById(db, server.id))!;
        return res.json({
          ok: true,
          server: serverView(fresh, await listMcpTools(db, server.id)),
          discovery: {
            offered: outcome.total,
            added: outcome.added,
            // Named back, not merely counted: "three of your tools were
            // switched off" is not something to leave somebody to notice.
            changedAfterApproval: outcome.changed,
            noLongerOffered: outcome.disappeared,
          },
          ...(session.offersTools ? {} : {
            note: 'That server answered, but it says it offers no tools. There is nothing here for '
              + 'Josi to use yet.',
          }),
        });
      } finally {
        await closeMcpSession(session);
      }
    }),
  );

  for (const [suffix, enabled] of [['enable', true], ['disable', false]] as const) {
    r.post(
      `/:id/${suffix}`,
      handle(async (req, res) => {
        const server = await ownedOr404(req, param(req, 'id'));
        if (enabled) await assertAllowed(db, server.host);
        const row = enabled
          ? await enableMcpServer(db, { actorUserId: req.user!.id, server })
          : await disableMcpServer(db, { actorUserId: req.user!.id, server });
        return res.json({ server: serverView(row, await listMcpTools(db, row.id)) });
      }),
    );
  }

  r.delete(
    '/:id',
    handle(async (req, res) => {
      const server = await ownedOr404(req, param(req, 'id'));
      await deleteMcpServer(db, { actorUserId: req.user!.id, server });
      return res.json({
        ok: true,
        note: 'Josi has deleted its copy of that server and any credential with it. If you gave it a '
          + 'token, revoke that token wherever you created it — Josi cannot do that from here.',
      });
    }),
  );

  // ------------------------------------------------------------ the allowlist

  /**
   * Approve one tool, having read it.
   *
   * `digest` is what the page had on screen. It travels with the decision so
   * the approval lands on the exact words somebody read: a server that swapped
   * the description between the page rendering and the button being pressed is
   * refused rather than approved.
   */
  r.post(
    '/tools/:toolId/approve',
    handle(async (req, res) => {
      const { server, tool } = await ownedToolOr404(req, param(req, 'toolId'));
      const body = (req.body ?? {}) as Record<string, unknown>;
      const row = await setMcpToolDecision(db, {
        actorUserId: req.user!.id,
        server,
        tool,
        state: 'approved',
        approvalMode: approvalModeOf(body.approvalMode),
        seenDigest: typeof body.digest === 'string' ? body.digest : undefined,
      });
      return res.json({ tool: toolView(row) });
    }),
  );

  r.post(
    '/tools/:toolId/revoke',
    handle(async (req, res) => {
      const { server, tool } = await ownedToolOr404(req, param(req, 'toolId'));
      const row = await setMcpToolDecision(db, {
        actorUserId: req.user!.id, server, tool, state: 'revoked',
      });
      return res.json({ tool: toolView(row) });
    }),
  );

  // -------------------------------------------------------- the approval gate

  /** Mine and only mine. The query is by `owner_user_id`, so there is no id for
   * a caller to substitute. */
  r.get(
    '/pending',
    handle(async (req, res) => {
      const rows = await listPendingMcpCalls(db, req.user!.id);
      return res.json({
        pending: rows.map((row) => ({
          id: row.id,
          serverName: row.server_name,
          toolName: row.tool_name,
          // What would happen, in words, before anybody agrees to it.
          summary: row.summary,
          requestedAt: row.created_at,
          expiresAt: row.expires_at,
        })),
      });
    }),
  );

  /**
   * Approve, and run — one route, one transaction's worth of guarantee.
   *
   * `claimApprovedMcpCall` moves the row out of `pending` with a conditional
   * UPDATE, so a double-tapped button or two open tabs produce one call and one
   * 409. The sealed payload is then re-hashed before anything is sent: an
   * approval that does not pin what it approved is a rubber stamp.
   */
  r.post(
    '/pending/:id/approve',
    handle(async (req, res) => {
      const key = requireKey(ctx);
      const call = await claimApprovedMcpCall(db, {
        callId: param(req, 'id'), decidedBy: req.user!.id,
      });

      const payload = openApprovedMcpRequest(key, call);
      // Re-resolved against the APPROVED set at this moment, by the same
      // owner-scoped query the tool call used. A tool revoked, a server
      // switched off, or a tool the server redescribed while somebody was
      // deciding all end here — an approval is not a way past an allowlist.
      const tool = await mcpToolById(db, call.tool_id);
      const server = tool ? await mcpServerById(db, tool.server_id) : null;
      const entry = server && server.owner_user_id === req.user!.id
        ? await resolveMcpTool(db, {
          ownerUserId: req.user!.id, slug: server.slug, toolName: payload.toolName,
        })
        : null;
      if (!entry || entry.server.id !== payload.serverId) {
        await recordMcpCallResult(db, {
          callId: call.id, ownerUserId: req.user!.id, ok: false, slug: 'unknown',
        });
        throw new RouteError(
          409,
          'that tool is no longer switched on, so Josi did not run it. Nothing was sent.',
        );
      }

      const refusal = policyRefusal(await mcpPolicy(db), entry.server.host);
      if (refusal) {
        await recordMcpCallResult(db, {
          callId: call.id, ownerUserId: req.user!.id, ok: false, slug: entry.server.slug,
        });
        throw new RouteError(403, refusal);
      }

      // The SAME code the assistant runs. Two implementations of "open a
      // session, call the tool, record what happened" is how one of them
      // forgets to record a refused credential.
      const outcome = await runMcpToolNow(
        db,
        { masterKey: () => key, mcpFetch: ctx.fetchImpl, resolve: ctx.resolve },
        // Every field comes from the SEALED payload, whose hash
        // `openApprovedMcpRequest` has just re-verified — not from the row,
        // which the far end could have redescribed while this waited. What is
        // sent is what was described, or nothing is sent at all.
        { userId: req.user!.id, entry, args: payload.arguments },
      );
      await recordMcpCallResult(db, {
        callId: call.id, ownerUserId: req.user!.id, ok: outcome.ok, slug: entry.server.slug,
      });
      // The server's own answer goes back to the person who authorised the
      // call. It is theirs; it is not written to a log or an event.
      return res.json(outcome.payload);
    }),
  );

  r.post(
    '/pending/:id/deny',
    handle(async (req, res) => {
      const row = await denyMcpCall(db, { callId: param(req, 'id'), decidedBy: req.user!.id });
      return res.json({ ok: true, status: row.status });
    }),
  );

  return r;
}

// ------------------------------------------------------------------- admin

export function adminMcpRoutes(ctx: McpRoutesCtx): Router {
  const r = Router();
  const { db } = ctx;
  r.use(requireSuperAdmin);

  /** The ceiling and the health table. Metadata only. */
  r.get(
    '/',
    handle(async (_req, res) => {
      const policy = await mcpPolicy(db);
      const rows = await db.query<McpServerRow & { username: string; approved_tools: number }>(
        `select s.*, u.username,
                (select count(*) from mcp_server_tools t
                  where t.server_id = s.id and t.state = 'approved' and t.available)::int
                  as approved_tools
           from mcp_servers s join users u on u.id = s.owner_user_id
          order by u.username, s.host`,
      );
      return res.json({
        policy: {
          allowed: policy.allowed,
          note: policy.note,
          allowedHosts: policy.allowedHosts,
        },
        servers: rows.map(adminServerView),
      });
    }),
  );

  /** Deny-only, by construction: this writes a ceiling, and there is nothing
   * anywhere in this file that connects a server on somebody's behalf or
   * approves a tool for them. */
  r.put(
    '/policy',
    handle(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const allowed = body.allowed !== false;
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) || null : null;
      const allowedHosts = validateMcpAllowedHosts(body.allowedHosts);
      const policy = await setMcpPolicy(db, {
        actorUserId: req.user!.id, allowed, note, allowedHosts,
      });
      return res.json({ policy });
    }),
  );

  /** An administrator may cut a connection off. That is plumbing: it removes
   * access, and at no point does it show them what was inside. Deliberately not
   * behind an ownership check — acting on somebody else's row is the whole
   * point, and that is exactly why this route reads nothing from it. */
  r.delete(
    '/connections/:id',
    handle(async (req, res) => {
      const server = await mcpServerById(db, param(req, 'id'));
      if (!server) throw new RouteError(404, 'not found');
      await deleteMcpServer(db, {
        actorUserId: req.user!.id, server, actor: 'super_admin',
      });
      return res.json({ ok: true });
    }),
  );

  return r;
}
