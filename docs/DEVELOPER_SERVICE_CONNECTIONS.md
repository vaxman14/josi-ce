# Native integrations

The **Integrations** page distinguishes available native integrations, coming-soon native
integrations, automation hubs, and **Custom API**. A catalog logo never means that Custom API
implements that provider.

## Ownership and secrets

Connections are user-scoped. An administrator chooses who may connect each provider; the user
supplies their own credential. Credentials are sealed with the installation Master Vault key and
never returned by member or administrator APIs. A provider identity check runs before storage.
Disconnect removes the connection and its Vault slot.

## Available API integrations

| Provider | Authentication and identity check |
| --- | --- |
| GitHub | personal access token → GitHub user API |
| GitLab | personal access token → GitLab user API |
| Cloudflare | API token → token verification API |
| Netlify | personal access token → Netlify user API |
| Vercel | access token → Vercel user API |
| Supabase | personal access token → project listing |
| Docker Hub | username + personal access token → short-lived JWT → user identity |
| GitHub Container Registry | GitHub package-scoped token → GitHub identity |
| Railway | account API token → GraphQL viewer query |
| Render | API key → owner listing |
| Sentry | user authentication token → organization listing |
| Linear | personal API key → GraphQL viewer query |
| Jira Cloud | Atlassian email + API token + HTTPS `*.atlassian.net` site → `myself` API |
| npm | granular access token → npm user API |
| Neon | API key → Neon user API |
| Notion | internal integration secret → bot identity; only explicitly shared pages are accessible |
| App Store Connect (`appstoreconnect`) | Issuer ID + Key ID + .p8 private key → short-lived ES256 token → `GET /v1/apps?limit=1` |
| Google Play (`googleplay`) | service account JSON + package name → RS256 JWT-bearer exchange → reviews list for that package |

Provider setup links to the provider's credential page and names the narrowest practical
credential. Re-check uses the sealed provider-specific fields. A failed check marks the connection
as needing reconnection and returns a sanitized error.

## Connection fields

`GET /api/connections/developer` describes every service's form as
`fields: [{ key, label, secret, multiline, help }]`, in display order. A client builds each form from
`fields` and sends the values back to `PUT /api/connections/developer/:service` as top-level body
keys named by `key` (the same keys nested under `fields` are also accepted). `secret` fields are
masked and never returned; `multiline` fields are a pasted file. The older `tokenLabel`,
`usernameLabel`, `emailLabel` and `baseUrlLabel` keys remain for existing clients, and a body of
`{ token, username?, email?, baseUrl? }` works as before. For the single-token providers `fields`
is derived: optional `username`, `email`, `baseUrl`, then `token`.

| Service | Body |
| --- | --- |
| `appstoreconnect` | `{ "issuerId": "…", "keyId": "…", "privateKey": "-----BEGIN PRIVATE KEY-----…" }` |
| `googleplay` | `{ "serviceAccountJson": "{ …the whole key file… }", "packageName": "com.example.app" }` |

## App Store Connect and Google Play

Neither store issues a token to paste; each issues a signing key, and the token is minted from it
for one call and discarded.

- **App Store Connect** takes a team API key. Josi signs an ES256 JWT (`kid` = Key ID, `iss` =
  Issuer ID, `aud` = `appstoreconnect-v1`, ten-minute expiry) and uses it as the bearer token.
  Individual (per-user) API keys, which have no Issuer ID, are not supported.
- **Google Play** takes a service account JSON key and one package name. Josi signs an RS256
  assertion for the `https://www.googleapis.com/auth/androidpublisher` scope, exchanges it at
  `https://oauth2.googleapis.com/token`, and uses the access token once. The `token_uri` inside the
  pasted file is ignored; only the account email, key id and private key are kept.

Pasted keys are normalised before use: surrounding whitespace is trimmed, `\r\n` and escaped
`\n` line breaks are accepted, and a key flattened onto one line is re-wrapped. A value that cannot
be a key (unreadable PEM, the wrong key type, JSON that is not a service account, a misshapen
Issuer ID, Key ID or package name) is refused with a specific message before any provider request.

The key is then checked with the store before it is saved. A rejected key is not stored, and the
error names the cause without quoting anything secret: Apple rejecting the key (Issuer ID or Key ID
not matching the .p8, or a revoked key), a role that cannot read apps, Google rejecting the service
account, the Android Developer API not being enabled, the service account having no access to the
package, or an unknown package. Apple does not say which of Issuer ID, Key ID or key was wrong, so
that message names all three. The connection is shown as `Key <Key ID>` or the package name.

All parts of a store key are sealed together as one Vault payload behind the same
`credentials_enc` reference as every other provider. No part is stored in a column, returned by any
route, or written to an audit event. Migration `0128_developer_service_fields.sql` only admits the
two service names; both start `not_allowed`.

## Obsidian

Obsidian is a native filesystem integration and never requests Sync credentials.
`GET /api/connections/developer/obsidian-vaults` examines the installer-owned `/workspace` mount
(or `JOSI_WORKSPACE_ROOT`) for directories containing `.obsidian`. Discovery is bounded, does not
follow symlinks, and returns workspace-relative display paths only.

## Assistant access

For users with a connection, read-only `list_native_integrations` reports that user's provider
identity, health, last check, and capability summary. It never returns credentials, ciphertext,
private host paths, or another user's connection.

Read-only `list_native_resources` performs bounded (maximum 25) provider-native discovery for the
connected account: repositories/packages for GitHub, GitLab, Docker Hub, GHCR and npm; projects for
Supabase, Railway, Neon and Jira; accounts/services/sites for Cloudflare, Render, Netlify and Vercel;
organizations or teams for Sentry and Linear; and explicitly shared pages/databases for Notion.
For App Store Connect it lists the team's apps, or, given `app_id`, that app's latest customer
reviews; for Google Play it lists the connected package's latest reviews. Both mint their
short-lived token from the sealed key for that one call. Review text is written by the public and is
returned as data (truncated to 500 characters); the stores have no write tools.
Requests use fixed provider endpoints (or Jira's constrained site), refuse redirects, and update
sanitized last-use/health metadata only after the owner-scoped credential is opened.

Connection status does not authorize provider actions. Provider reads and writes require separate
provider-specific tool contracts. Consequential writes must show the exact target and input and
receive fresh local approval; provider consent and local action approval are separate controls.

## Automation hubs and Custom API

Zapier, n8n, and Make use the native workflow subsystem, not `custom_api_connections`. Custom API
remains the reviewed fallback for otherwise unsupported REST services and uses its own host/method
allowlist, SSRF controls, Vault slots, and audit records.

## Security and verification

- Every provider defaults to `not_allowed` after migration.
- Permission is enforced on writes, not merely hidden in the UI.
- Provider hosts are fixed in source except Jira's constrained `*.atlassian.net` site.
- Tokens use authorization headers or provider-required login bodies, never query strings.
- Audit events name the provider and action but never contain credentials.
- Obsidian traversal stays beneath the canonical root and refuses symlink escapes.
- Contract tests cover endpoint/auth/parser behavior, default deny, isolation, sealed storage,
  reconnect, disconnect, metadata-only admin views, Obsidian traversal, and assistant isolation.

## Workflow setup, consent, and callbacks

Use **Administration → Native workflow providers** to test and save an account,
then discover workflows and expose only the reviewed entries. Reconnecting an
account withdraws every exposure; review them again before enabling access.
Members use **Automation workflows** to prepare a run, review its exact input,
and approve it. The assistant can prepare the same request but cannot approve it.
Approval expires after 15 minutes. Credential, execution-target, schema, or
exposure changes invalidate a pending request. History retains fixed completion
summaries, not provider response bodies or plaintext inputs, for 30 days.

- **Zapier:** use the official MCP connection token. Josi initializes a Streamable
  HTTP session, supports JSON and SSE responses, discovers its tools and schemas,
  and calls the selected tool after approval. Tool errors remain failures.
- **n8n:** use a public API key for active-workflow discovery. Register the
  production `/webhook/…` path and its JSON input schema separately. Configure the
  Webhook node's Header Auth with header `X-Josi-Workflow-Key` and the integration's
  signing secret. The API key is never sent to workflow webhooks. The run request
  includes `X-Josi-Run-Id`; return an `executionId` or use that run ID when posting
  completion. A successful HTTP acceptance alone does not mean the workflow
  completed. Public endpoints use validated, pinned DNS addresses; private HTTPS
  endpoints require the administrator's explicit LAN option.
- **Make:** choose the API region (`eu1`, `eu2`, `us1`, or `us2`), token, and numeric
  team/organization ID. Josi discovers scenarios and their input interfaces,
  validates inputs, and uses the responsive scenario-run API. Numeric success,
  warning, and error statuses are handled. Network failures can leave an external
  operation in progress; inspect the provider before approving a replacement run.

To deliver a completion callback, POST JSON
`{"runId":"the-execution-id","status":"succeeded"}` (or `failed`) to
`/api/workflow-callbacks/INTEGRATION_ID` on Josi's current public origin. Send a
unique `X-Josi-Event-Id`, Unix-seconds `X-Josi-Timestamp`, and `X-Josi-Signature`
containing `sha256=` followed by the hex HMAC-SHA256 of
`timestamp + "." + exactRequestBody`, keyed by the integration's signing secret.
Timestamps must be within five minutes. An unknown run does not consume the event
ID. Successful callbacks are deduplicated. Provider automation must explicitly
construct this signed callback; an unsigned provider default callback is refused.
Signing secrets and API credentials use the installation Vault. Disconnect
withdraws access immediately and removes its Vault slots.

Obsidian discovery and Markdown reading are administrator-only because the
installer workspace is shared infrastructure, not a per-member directory.
Use the Obsidian section in Integrations or the `list_obsidian_vaults` and
`read_obsidian_note` assistant tools. Paths stay workspace-relative; hidden files,
symlinks, traversal, non-Markdown files, and notes over 256 KB are refused.
No write operation modifies attachments, links, frontmatter, or configuration.

Protocol references: [Zapier MCP](https://docs.zapier.com/mcp/home),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports),
[Make scenarios](https://developers.make.com/api-documentation/api-reference/scenarios),
[npm identity](https://docs.npmjs.com/cli/v11/commands/npm-whoami/), and
[Supabase project discovery](https://supabase.com/docs/reference/api/v1-list-all-projects).
