# Integrations — design and ownership decision

The administration page is named **Integrations**. It groups code and deployment, data and
monitoring, knowledge, and project-management services in one place. GitHub, Netlify, Vercel, and
Supabase retain their per-user token flow. The catalog also identifies GitLab, Cloudflare, Docker
Hub/GHCR, Railway/Render, npm, Neon, Sentry, Notion, Obsidian, Linear, and Jira. Obsidian uses the
optional `/workspace` filesystem mount rather than a cloud credential.

Unsupported REST services use **Custom API**, with Vault-protected credentials, an explicit
endpoint/method allowlist, read-only defaults, approval for writes/deletes, SSRF protection, and
redacted audit records.

GitHub, Netlify, Vercel and Supabase, connected from **Workspace → Integrations**.
This document records the decisions the code enforces, so a later
change that contradicts one of them is visibly a change rather than a drift.

## The ownership decision: user-scoped

**These are user-scoped services, not installation-admin services.**

Read out of the current architecture rather than chosen for convenience:

| Fact in the codebase | What it implies |
| --- | --- |
| `connections` is keyed by `owner_user_id`, and `packages/core/src/ownership.ts` never branches on role | Anything that acts as a person belongs to that person |
| `NEVER_SHAREABLE` already contains `connection`, because sharing an OAuth grant is account handover, not collaboration | A credential that acts as somebody is not workspace property |
| The settled Telegram decision (round-3 item 19) moved a shared bot token to one bot per user, for exactly this reason | The precedent in this product is per-user for act-as credentials |
| Installation-wide credentials in CE — SMTP profiles, OAuth *client* registrations, the LLM provider key — are all things the operator configures **for** the product, not credentials that act **as** a person | These four are not in that class |

A GitHub personal access token commits, comments and reviews under its owner's
name. A Netlify or Vercel token deploys to their team. A Supabase personal
access token administers their projects. An installation-wide token for any of
them would mean every member of the installation acting as one person's account,
which is precisely the "preset, silently configured, globally available" shape
the requirement forbids.

So: `developer_service_connections.owner_user_id`, one row per person per
service, `on delete cascade` with the account.

### What the administrator keeps

Exactly the authority they already have over an OAuth connection, and no more:

* **See** that a connection exists, whose it is, and whether it works
  (`GET /api/admin/developer-services`). Metadata only — the DTO is run through
  `assertMetadataOnly`, and `account_label`, `reported_scopes`, `project_ref`
  and `credentials_enc` were added to that guard's forbidden-key set.
* **Disconnect** somebody's connection
  (`DELETE /api/admin/developer-services/connections/:id`). Removing access is
  administration; reading it is not, and that route reads nothing from the row.
* **Forbid** a service installation-wide (`developer_service_policy`). Deny-only
  by construction: the table has an `allowed` column and there is no code path
  anywhere that connects a service on somebody else's behalf. Switching a
  service back on returns the choice to each person; it connects nothing.

  The ceiling is checked on every route that *uses* a credential, not only on
  the one that stores it — otherwise "switched off for this installation" would
  mean "switched off for people who had not got round to it yet". Listing and
  disconnecting stay available: a ceiling must never trap somebody's live token
  inside Josi with no way to take it back.

What the administrator cannot do: read a token, see which account or project it
points at, see what it may do, or connect a service for somebody else.

## Why this is not part of the Connections page

The Connections page is OAuth: an application the operator registered, a
provider consent screen that names scopes, per-capability switches, refresh
tokens, and incremental consent. None of that applies to a pasted personal
access token. Rendering the two on one page would teach people that a token they
pasted was scoped by a consent screen they never saw.

They are also deliberately distinct from:

* **model providers** (`packages/llm`) — a key the assistant reasons with;
* **messaging Channels** (`packages/channels`) — inbound and outbound transports;
* **Custom API connections** (`docs/CUSTOM_API_CONNECTIONS.md`) — a separate
  feature with a separate table. There the host comes from a form and the
  assistant picks which of several reviewed actions to call; here the host is
  pinned in CE's own source and the assistant gains no tool at all.
* **MCP servers** — a separate ledger item, not implemented. Nothing in this
  change adds a general outbound HTTP capability.

A pointer card on the Connections page links to the new page, so somebody
looking in the obvious place finds it.

## Least privilege, stated honestly

CE cannot request a narrower token than a provider offers. Where a provider has
no read-only or per-resource token, the page says so instead of implying a scope
was requested:

| Service | Minimum asked for | Honest caveat shown above the field |
| --- | --- | --- |
| GitHub | Fine-grained token, selected repositories, Metadata + Contents read-only, with expiry | none — GitHub genuinely offers this |
| Netlify | A token created for Josi alone | Netlify tokens cannot be scoped at all |
| Vercel | Scoped to one team, with an expiry | a Vercel token is scoped to a team, not to an action |
| Supabase | A personal access token | account-wide; a `service_role` project key is **refused** |

The Supabase refusal is the one input rule that is about privilege rather than
shape: a `service_role` key bypasses every row-level security policy on a
project, and pasting it where a personal access token belongs is the most
damaging mistake this page allows.

## Security boundaries

* **At rest.** `seal()` with the installation master key before the value
  reaches a query (`packages/core/src/sealing.ts`). The row holds no prefix,
  suffix, length or hash of the token. A database dump without the key yields
  nothing usable.
* **On the way out.** The owner's readback is a constant mask (`TOKEN_MASK`),
  not a derived one — a mask made of the secret is still made of the secret. The
  admin view is metadata. The ciphertext is not served either.
* **Audit.** `developer_service.connected | tested | disconnected |
  revoked_by_admin | permitted | forbidden`, carrying the service and an outcome
  category. Never the token, never the account, never the provider's words.
  `appendEvent` refuses a `token` key as a backstop.
* **Diagnostics.** A `dev_service_token` redaction pattern was added to
  `packages/ops/src/diagnostics.ts` for the documented `ghp_`/`github_pat_`/
  `sbp_`/`nfp_` prefixes. Bundles are exclusion-shaped and read no content
  table, so the new tables are outside them by construction.
* **Outbound.** One pinned host per service. No part of the connect form is a
  URL, host, port or path. Every resolved address is checked **at request time**
  (DNS rebinding), anything off the public internet is refused, redirects are
  not followed, the response body is size-capped, and the token travels in a
  header — never in a URL.
* **Nothing unverified is stored.** The token goes to the provider first; a row
  exists only after the provider accepted it. A refused token leaves no row.

## Files

| File | What it is |
| --- | --- |
| `packages/db/migrations/0034_developer_service_connections.sql` | `developer_service_connections`, `developer_service_policy` |
| `packages/connectors/src/devServices.ts` | catalogue, guided setup text, validation, sealed storage |
| `packages/connectors/src/devServiceProbe.ts` | pinned-host fetch, address policy, per-service identity probe |
| `apps/api/src/http/devServiceRoutes.ts` | member and admin routes |
| `apps/web/src/pages/DeveloperServices.tsx` | the page people use |
| `apps/web/src/pages/admin/DeveloperServices.tsx` | ceiling and health |
| `packages/connectors/test/devServices.test.ts` | validation, sealing, address policy, probes |
| `apps/api/test/developerServices.test.ts` | auth, isolation, storage, masking, tests, disconnect, SSRF, redaction |
| `docs/INSTALLATION.md` §17C | the operator manual section |
| `docs-site/body.html` §18 | the help documentation (published site) |
| `docs/THREAT_MODEL.md` T-80…T-83 | the four threats, each naming a control and a test |

## Deliberately not done

* No assistant tool reads a developer service. Storing a credential and
  reporting its health is the whole scope of this item; giving the model a
  GitHub reader is a separate decision with separate consent questions.
* No write action against any of the four. Every probe is a read-only identity
  call.
* No token revocation at the provider. None of the four exposes an API for it,
  so disconnect deletes CE's copy and the page names where to finish the job
  rather than claiming a revocation that did not happen.
