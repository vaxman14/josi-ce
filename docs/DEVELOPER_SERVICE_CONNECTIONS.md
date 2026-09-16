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

Provider setup links to the provider's credential page and names the narrowest practical
credential. Re-check uses the sealed provider-specific fields. A failed check marks the connection
as needing reconnection and returns a sanitized error.

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
