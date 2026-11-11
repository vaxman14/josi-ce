# Custom MCP servers

An MCP server is a web address that gives an assistant extra tools: search a
notes app, file a ticket, look something up. This feature lets **each person add
their own MCP servers** to Josi, with their own sign-in. Josi can then use those
tools in that person's conversations, and in nobody else's.

This page says what is built, who may use it, what is enforced where, what a
server can and cannot do, the limits, and every route with its request and
response. The iPhone app can be built from the routes section alone.

## Who can add a server

* **The owner of the installation** (role `super_admin`) always can.
* **Members** can only if the owner allows it. There is one permission for the
  whole installation, with three settings: `not_allowed` (the default),
  `everyone`, or `specific_users` (a list of people). It is the same idea as the
  permission on a developer service.
* A person can add up to **20** servers.

Withdrawing the permission does not delete what a member already added. Josi
stops offering and using their servers at once; the member can still switch one
off or remove it. Giving the permission back makes them work again without
anything being pasted a second time.

The owner sees, per server: who added it, the name they gave it, the host, and
whether it works. The owner does **not** see the full address, the tools, the
sign-in, or anything that went through it, and cannot use or approve anything on
somebody else's server.

## What kind of server

Remote servers only: an `https://` address that speaks MCP **Streamable HTTP**.

* No stdio. Nothing here starts a program on the Josi machine.
* No plain `http://`.
* The address must be on the public internet. Every request (to the server, and
  to every sign-in address the server points at) resolves the host first and is
  refused if any answer is loopback, private (10/8, 172.16/12, 192.168/16),
  link-local (169.254/16, fe80::/10), CGNAT (100.64/10), multicast, or
  unique-local (fc00::/7). A literal address is checked the same way.
* Redirects are never followed. Every request has a 20 second timeout and a
  1 MB ceiling on what is read (256 KB for sign-in documents).

## Signing in

Four methods, chosen when the server is added:

| `auth`   | What the person gives | What is sent |
| -------- | --------------------- | ------------ |
| `none`   | nothing | nothing |
| `bearer` | a token | `Authorization: Bearer <token>` |
| `header` | a header name and a value | `<name>: <value>` |
| `oauth`  | nothing, or a client id (and optional client secret) | browser sign-in, then `Authorization: Bearer <access token>` |

A header name may not be one the connection itself needs (`Content-Type`,
`Accept`, `Host`, `Mcp-Session-Id`, `Cookie` and similar).

### Browser sign-in (`oauth`)

This follows the MCP authorization rules:

1. Josi contacts the server without a sign-in and expects `401`.
2. It reads `resource_metadata` from the `WWW-Authenticate` header, or asks
   `/.well-known/oauth-protected-resource` (with the server's path, then
   without). A server that publishes neither is treated as its own sign-in
   server.
3. It reads the sign-in server's description from
   `/.well-known/oauth-authorization-server`, falling back to
   `/.well-known/openid-configuration`. The description must be about the
   sign-in server that was asked for, its addresses must be https, and if it
   lists challenge methods, `S256` must be one of them.
4. If the description has a `registration_endpoint`, Josi registers itself
   (RFC 7591) as a public client. If not, the add is refused with
   `code: "client_id_required"` and the person pastes a client id (and a client
   secret if the server issued one), having registered an app there with the
   return address below.
5. Sign-in is authorization code with **PKCE S256**, the `resource` parameter
   set to the server's address, and a **single-use state** tied to the person
   and the connection. The state is stored as a hash; the PKCE verifier is
   sealed in the person's Vault and erased when used.
6. Tokens and the refresh token are stored sealed. The access token is
   refreshed before use when it has run out, and once more if the server
   answers `401` anyway. If that fails the connection is marked "sign-in
   needed".

**Return address (redirect URI):**
`<the installation's public address>/api/connections/mcp/oauth/callback`.
`GET /api/connections/mcp` returns it as `redirectUri`. It is fixed at the time
a server is added; if the installation's address changes, remove the server and
add it again.

## Which tools run on their own, and which ask

All of a connected server's tools are available. For each one:

* If the server marks it read-only (`annotations.readOnlyHint === true` in
  `tools/list`, and exactly `true`), Josi **runs it straight away**.
* **Everything else** — no annotation, or not read-only — **asks the person
  first, every time**. Nothing is sent until they approve, and what is sent is
  exactly what they were shown.

This is decided only from that flag. A tool's description cannot change it, the
model cannot change it, and no personal approval setting can change it.

**A tool cannot quietly stop asking.** If a tool was once seen without the
read-only mark and the server later adds it, Josi keeps asking about that tool
until the person presses **Check it still works** on the Connections page
themselves. The Connections page says when a server has such a tool. A tool
that loses its read-only mark starts asking immediately.

The person can also switch any single tool off, or the whole server off.

## How an approval works, end to end

1. In a conversation, the assistant calls a tool that is not read-only.
2. Josi does **not** contact the server. It stores a pending request for that
   person: the connection, its address, the tool and the exact arguments,
   sealed, with a hash that pins them. The assistant is told the tool has not
   run and says so in the chat.
3. The request appears on the person's **Approvals** page (web) under "Tools on
   your MCP servers", and in `GET /api/connections/mcp/pending` (phone). The
   phone also gets the usual approval notification, "Your approval is needed.",
   with no detail on the lock screen.
4. The person approves or declines. Only the person whose request it is can do
   either; for anybody else, including the owner of the installation, the
   request does not exist (`404`).
5. Approving runs the tool **once**, with exactly the sealed arguments. Before
   it runs Josi checks again that the person is still permitted, the server
   still exists and is switched on, its address has not changed, and the tool
   is still there and switched on. A second press is refused (`409`).
6. The answer is returned to the person who approved. It is also kept, sealed,
   for up to 30 minutes so the conversation can collect it: when the assistant
   makes **the very same call again**, it is given the answer once, and the
   tool is not run again. After that, the same call is a new request and asks
   again.
7. A request nobody answers expires after 30 minutes.

## What a server can and cannot do

Everything a server sends is treated as untrusted.

A server **can**:

* offer tools, and have Josi run the read-only ones for the person who added it;
* have its other tools run when that person approves each call;
* return text, which the assistant reads as *data from an outside server*.

A server **cannot**:

* be reached by anyone but the person who added it;
* make a tool skip the approval by describing it as safe;
* change an approved call (the arguments are sealed and pinned);
* call back into Josi: Josi declares no abilities to the server (no sampling,
  no roots, no elicitation) and ignores server requests;
* send Josi to another address by redirecting;
* reach addresses inside the Josi machine's network;
* put control characters, hidden direction marks or oversized text into a tool
  name, a description or a result;
* get its error text into a log, an audit record or a stored column. A failure
  is stored as a sentence Josi wrote.

What a server says still reaches the model, and a model can be misled by what
it reads. That is why only read-only tools run unasked, why every result is
labelled as outside data, and why a person should only add servers they trust.

## Where the sign-in is kept

A token, a header value, a client secret and OAuth tokens are one sealed entry
in **the person's own Vault box** (service `mcp`, slot = the connection id). The
connection row holds a reference to it and nothing else. Removing the server
removes the entry.

No route returns a credential. A secret appears only as `credentialSet: true`
or `false`. Audit events (`mcp.connection_added`, `mcp.connection_updated`,
`mcp.connection_removed`, `mcp.signed_in`, `mcp.policy_set`,
`mcp.call_requested`, `mcp.call_approved`, `mcp.call_denied`,
`mcp.call_executed`, `mcp.call_failed`) carry the short name, the host, the
kind of sign-in and the tool name — never a credential, an argument or an
answer. If a server echoes the sign-in back in an answer or an error, it is cut
out before the assistant sees it.

## Limits

| What | Limit |
| ---- | ----- |
| Servers per person | 20 |
| Tools kept per server | 100 (more are left out, and the page says how many) |
| Tool description | 300 characters |
| A tool's input description (schema) | 8 KB, larger and the tool is left out |
| Tool name from the server | 128 characters, no control characters |
| Arguments sent to a tool | 64 KB |
| Tool answer passed to the assistant | 20,000 characters, text only; other content is named as left out |
| Tools offered by name in one turn | 80, across all of a person's servers |
| Unanswered approval | expires after 30 minutes |
| Sign-in started but not finished | expires after 10 minutes |

## What the assistant sees

* `list_mcp_servers` — offered to anyone who has added a server. Lists their
  servers, whether each works, and each tool with whether it asks first.
  `server` shows one server's tools in full; `refresh: true` asks the servers
  what they offer now (a refresh like this can add tools but cannot make a tool
  stop asking).
* One tool per server tool, named `mcp_<short name>__<tool>` (letters, digits,
  `_` and `-`; at most 64 characters; unique). Its description names the server
  and says whether it asks first.
* `call_mcp_tool` (`server`, `tool`, `arguments`) — offered instead of the
  per-tool names when the model is a ChatGPT or Claude subscription plan (their
  tools run in a separate Josi process that only knows a fixed list), and
  alongside them when a person has more than 80 tools.

Tools are offered only for a server that is switched on, last answered, and
whose owner is still permitted. All of this is re-checked when a tool is called.

## Routes

All under `/api`. Every route needs a signed-in session (cookie plus CSRF
header on the web, bearer on the phone) except the browser callback. Errors are
`{ "error": "<sentence for a person>" }`; statuses: `400` bad input, `401` not
signed in, `403` not permitted, `404` not found or not yours, `409` conflict,
`423` Vault locked, `502` the outside server failed (`category` says how).

### The connection object

```json
{
  "id": "uuid",
  "name": "My notes",
  "slug": "my_notes",
  "url": "https://example.com/mcp",
  "host": "example.com",
  "auth": "none | bearer | header | oauth",
  "headerName": "X-API-Key or null",
  "credentialSet": true,
  "oauth": { "signInServer": "login.example.com", "signedIn": true, "expiresAt": "ISO time or null" },
  "status": "active | needs_sign_in | needs_attention",
  "enabled": true,
  "lastCheckAt": "ISO time or null",
  "lastCheckOk": true,
  "lastError": "a sentence, or null",
  "serverName": "what the server calls itself, or null",
  "toolsFetchedAt": "ISO time or null",
  "toolsLeftOut": 0,
  "tools": [
    { "name": "search", "description": "…", "readOnly": true, "asksFirst": false, "enabled": true }
  ]
}
```

`oauth` is `null` unless `auth` is `oauth`. `readOnly` is what the server says
now; `asksFirst` is what Josi does. They differ (`readOnly: true`,
`asksFirst: true`) for a tool that used to be able to change things, until the
person checks the connection.

### `GET /connections/mcp`

```json
{ "allowed": true, "note": "the owner's reason, or null", "maxConnections": 20,
  "redirectUri": "https://…/api/connections/mcp/oauth/callback",
  "connections": [ /* connection objects, mine only */ ] }
```

### `POST /connections/mcp` — add a server

Request:

```json
{ "name": "My notes", "url": "https://example.com/mcp", "auth": "bearer",
  "slug": "optional short name",
  "token": "for bearer",
  "headerName": "for header", "headerValue": "for header",
  "clientId": "optional, for oauth", "clientSecret": "optional, for oauth" }
```

For `none`, `bearer` and `header` the server is contacted and its tools listed
**before** anything is saved. `201`:

```json
{ "ok": true, "signInNeeded": false, "connection": { /* … */ } }
```

For `oauth`, discovery and registration happen and the connection is saved with
`status: "needs_sign_in"`. `201` with `"signInNeeded": true`; then call
`…/oauth/start`. If the sign-in server will not register Josi: `400` with
`"code": "client_id_required"` and nothing saved.

### `PATCH /connections/mcp/:id`

Any of `{ "name": "…", "enabled": true, "disabledTools": ["tool name", …] }`.
`disabledTools` replaces the whole list. Returns `{ "ok": true, "connection": … }`.
Sending only `{ "enabled": false }` works even when the permission has been
withdrawn.

### `POST /connections/mcp/:id/check`

Contacts the server and refreshes the tool list. This is the person checking
for themselves, so a tool that is now marked read-only stops asking.

```json
{ "ok": true, "detail": "My notes answered and offers 3 tools.", "connection": { /* … */ } }
```

A failed check is `200` with `"ok": false` and the reason in `detail`.

### `DELETE /connections/mcp/:id`

`204`. Removes the server, its sealed sign-in and its pending requests. Always
allowed for its owner.

### `POST /connections/mcp/:id/oauth/start`

Request `{ "native": true }` from a phone app, `{}` from the web. Returns:

```json
{ "ok": true, "authorizationUrl": "https://login.example.com/authorize?…" }
```

Open that address in a browser.

### `GET /connections/mcp/oauth/callback?code=…&state=…`

Where the browser comes back. Not called by an app.

* With a Josi session that belongs to the person who started the sign-in:
  finishes it and redirects to `/app/connections?mcp=connected`, or to
  `/app/connections?mcp_error=<reason>`, where the reason is one of
  `declined`, `expired`, `consumed`, `unknown`, `wrong_person`, `session`,
  `failed`.
* With no session, for a sign-in started with `native: true`: redirects to
  `josi://connections/mcp/callback?state=…&code=…` (or `&error=declined`).
  Nothing is finished by that redirect.

### `POST /connections/mcp/oauth/complete` — phone

Request `{ "state": "…", "code": "…" }` (or `"error": "declined"`), with the
app's own session. It must be the session of the person who started the
sign-in. Returns `{ "ok": true, "connection": … }`; `404` for a state that is
unknown or somebody else's, `409` for one that was used, expired or declined.

### `GET /connections/mcp/pending`

```json
{ "pending": [ { "id": "uuid", "connectionName": "My notes", "host": "example.com",
  "tool": "send_message", "summary": "Josi wants to use the tool … With: to: …",
  "requestedAt": "ISO time", "expiresAt": "ISO time" } ] }
```

Mine only. The approval notification queued for the phone has category
`approval`, route type `approval`, and this `id` as its route id. It is not an
id from `/api/assistant/approvals`; look it up here.

### `POST /connections/mcp/pending/:id/approve`

Runs the tool now. Returns:

```json
{ "ok": true, "result": { "text": "…", "toolReportedError": false, "truncated": false, "leftOut": [] } }
```

`ok` is `false` when the tool itself reported an error. `404` if the request is
not yours; `409` if it was already decided, expired, or the server or tool
changed while it waited; `403` if the permission was withdrawn.

### `POST /connections/mcp/pending/:id/deny`

`{ "ok": true, "status": "denied" }`.

### Accounts a parent manages

An account that is a managed child (Parental Controls) may not add or use MCP servers, even when the
policy is "everyone", unless the owner turns on `allowManagedChildren`. It is off by default, it is
one switch for the whole installation, and it does not tell the owner which accounts are managed.
`GET` returns `allowManagedChildren`; `PUT` accepts it as a boolean and leaves it alone when absent.
Added by migration 0134, after beta.18.

### `GET /admin/mcp/policy` — owner only

```json
{ "mode": "not_allowed | everyone | specific_users", "note": "… or null",
  "allowedUserIds": ["uuid"], "summary": "a sentence",
  "people": [ { "id": "uuid", "username": "…", "email": "…" } ],
  "connections": [ { "userId": "uuid", "username": "…", "name": "…", "host": "…",
    "status": "active", "enabled": true, "lastCheckAt": "…", "lastCheckOk": true } ] }
```

### `PUT /admin/mcp/policy` — owner only

Request `{ "mode": "specific_users", "note": "optional", "userIds": ["uuid"] }`.
Leaving `userIds` out keeps the stored list; an empty list means nobody.
Returns `{ "ok": true, "mode": …, "note": …, "allowedUserIds": […] }`.

## Database (migration 0133)

* `mcp_policy` — the one installation-wide permission.
* `mcp_allowed_users` — the named people for `specific_users`.
* `mcp_connections` — one row per server per person: name, short name (unique
  per person), address, host, sign-in method, a Vault reference, non-secret
  OAuth facts, health, the cleaned tool list, switched-off tools, and the names
  of tools that must keep asking.
* `mcp_oauth_states` — browser sign-ins in progress: a hash of the state, who,
  which connection, a Vault reference to the PKCE verifier, single use.
* `mcp_pending_calls` — tool calls waiting for approval: sealed arguments, the
  pinning hash, the decision, and the sealed answer until it is collected.

Row level security is enabled on all five, as on neighbouring tables.

## Where it lives in the code

* `packages/connectors/src/mcpClient.ts` — the protocol, the address guard, all
  cleaning and bounds.
* `packages/connectors/src/mcpOAuth.ts` — discovery, registration, PKCE, tokens.
* `packages/connectors/src/mcpConnections.ts` — the permission, storage, the
  Vault, refresh, and the rule about which tools ask.
* `packages/connectors/src/mcpCalls.ts` — pending requests and approvals.
* `packages/agent/src/mcpTools.ts` — what the assistant is offered and how a
  call is run or held.
* `apps/api/src/http/mcpRoutes.ts` — the routes above.
* `apps/web/src/components/McpServers.tsx`, `apps/web/src/pages/admin/McpPolicy.tsx`,
  `apps/web/src/pages/Approvals.tsx` — the screens.

## What is not built

* **Local servers (stdio).** Only remote https servers.
* **The older "HTTP+SSE" transport** with a separate event address. Only
  Streamable HTTP.
* **Anything but tools.** A server's resources, prompts, sampling, roots and
  elicitation are not used. Server-to-Josi requests are ignored.
* **Pictures, sound and files in answers.** Text only; the rest is named as
  left out.
* **Approval cards inside the chat.** As with a Custom API, the assistant says
  in the chat that a request is waiting, and the person approves it on the
  Approvals page (or in the phone app from `…/pending`).
* **"Always allow this tool."** Every call to a tool that is not read-only asks.
* **Shared servers.** A server belongs to one person. There is no
  installation-wide MCP server and no sharing between people.
* **Editing a server's address or sign-in.** Remove it and add it again, so the
  server is asked afresh.
* **Unattended (background) work** has not been tested with MCP tools.
* **Automatic refresh of tool lists.** A list is refreshed when the person
  presses Check, signs in, or when the assistant asks through
  `list_mcp_servers`.
