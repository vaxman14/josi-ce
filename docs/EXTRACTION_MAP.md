# Extraction map: josi-engine → josi-ce

What comes across from the commercial engine, what is deliberately left behind,
and what has to be rebuilt because CE's isolation model is genuinely different.

Source audited: `/Volumes/josi/Projects/josi-engine` @ `2fbdf75`, 31,455 lines of
TypeScript/SQL across 8 packages and 3 apps.

**This is not a fork.** The engine is multi-tenant with a fleet of customers
above it. CE is one workspace with several people inside it. Those two sentences
have different isolation axes, and that difference — not the feature list — is
what decides what can be copied and what cannot.

---

## 1. The one architectural difference that drives everything

| | josi-engine | josi-ce |
|---|---|---|
| Isolation axis | `tenant_id` — one business per tenant, all its users share everything | `owner_user_id` — one workspace, resources private **per user** |
| Scope decision point | `scopeTenant()` | `scopeWorkspace()` + `requireOwnerOrShared()` |
| Admin | SoCal operator, above all tenants | super admin, **inside** the workspace, policy-only |
| Admin content access | can read any tenant's data | **must not** read a user's mail, files or calendar |

In the engine, two users of the same tenant see the same conversations, the same
contacts, the same calendar. In CE the canonical map is explicit that mapped
folders, their indexes, connected accounts and operational email threads are
**private to the owning user by default** (map lines 30, 37, 68), and that the
super admin administers plumbing, not content (lines 36, 38, 48, 72, 78).

So CE gains an isolation axis the engine never had. `scopeTenant` cannot simply
be renamed — a second check has to exist for "is this row yours, or shared with
you?". Everything in §4 below flows from that.

The engine's *discipline* transfers even where its code does not: one decision
point, server-side, never inferred from the URL, asserted over the wire in
tests. That is the part worth keeping.

---

## 2. Reuse: take, mostly as-is

Domain logic that is genuinely tenant-agnostic. `tenant_id` becomes
`workspace_id` (a constant per installation) or `owner_user_id` per §4.

| Source | LOC | Why it survives |
|---|---|---|
| `packages/core/src/tasks.ts` | 190 | Task state machine. No hosted assumptions. |
| `packages/core/src/events.ts` | ~90 | Append-only event log; the audit trail CE needs (map 72). |
| `packages/core/src/locks.ts` | ~120 | Resource locks + holds. Booking correctness. |
| `packages/core/src/queue.ts` | ~110 | Job queue for the worker. |
| `packages/core/src/authority.ts` + `secondFactor.ts` | 313 | Approval gates + PIN. Directly serves map 31–33 (approval levels). |
| `packages/core/src/metering.ts` + `pricing.ts` | ~230 | Token/cost accounting → CE caps (map 87–88). |
| `packages/core/src/metrics.ts` | ~140 | Interrupt/correction rate. |
| `packages/core/src/db.ts` | ~90 | Postgres adapter. Drop the Supabase comment. |
| `packages/agent/*` | ~500 | The actual assistant: owner agent, provider abstraction. |
| `packages/tools/src/calendar.ts`, `booking.ts`, `availability.ts`, `agentTools.ts` | ~700 | Provider-neutral calendar seam + holds. Already an interface. |
| `packages/tools/src/mail.ts`, `mailTools.ts`, `html.ts`, `http.ts` | ~800 | Provider-neutral mail seam, HTML→text, timeouts/retries. |
| `packages/tools/src/emailApprovals.ts` | 355 | Content-hash approval + exactly-once send. Serves map 41–44 directly. |
| `packages/tools/src/crypto.ts`, `credentials.ts` | ~170 | AES-256-GCM sealed credentials → map 100 (master key outside DB). |
| `packages/tools/src/oauth/state.ts` | ~200 | Single-use PKCE state. |
| `packages/tools/src/google/*`, `microsoft/*` | ~1,100 | Gmail, Graph mail, both calendars. Adapt to operator-supplied clients (§5). |
| `packages/recall/*` | ~1,200 | Chunk → link → recall. CE uses Postgres FTS by default (map 51). |
| `apps/owner-web/src/components/ui/*` | ~600 | shadcn-style primitives; current visual language. |
| `apps/owner-web/src/pages/tenant/*` | ~1,800 | Dashboard, Talk, Tasks, Approvals, Conversations, Contacts, Business profile, Usage, Connections. This is the product. |
| `apps/owner-web/public/brand/*` | assets | **Mandatory** official Josi identity (map 7–10, 81). |

**Reuse rule:** where a file needs only `tenant_id → workspace_id`, it is edited,
not rewritten. Do not invent replacement logic for working code.

---

## 3. Exclude: hosted-only, commercial, or unsafe

### 3a. Fleet / licensing / commercial — excluded entirely

| Source | Reason |
|---|---|
| `packages/core/src/licenses.ts` | License keys, plans, seats, revocation. CE is free; there is no license. |
| `packages/core/src/gate.ts` (license half) | `no_license` / `license_expired` gate reasons. CE keeps the **cap** half only. |
| `packages/core/src/onboarding.ts` | Provisions *new tenants*. CE has one workspace, created by the setup wizard. |
| `packages/core/src/export.ts` (kill path) | Tenant kill/export for offboarding a customer. CE replaces with backup/export (§6). |
| `apps/api/src/portal/adminRoutes.ts` | 687 lines of fleet ops: tenant CRUD, licenses, kill switch, caps per tenant, Twilio number assignment. **Rewritten**, not ported. |
| `apps/owner-web/src/pages/admin/Tenants.tsx`, `TenantDetail.tsx`, `Licenses.tsx`, `Overview.tsx`, `LineHealth.tsx` | Fleet console. No equivalent in CE. |
| `apps/api/src/portal/hosts.ts` + `hosts.test.ts` | Three-hostname split (`engine`/`app`/`control`.heyjosi.com). CE is one host. |
| `apps/owner-web/src/pages/admin/Recall.tsx` | Per-tenant recall health across a fleet. |

### 3b. SoCal-specific — excluded, and must never appear in CE

| Source | Reason |
|---|---|
| `packages/core/src/onboarding.ts` `PROTECTED_NUMBERS` | `+19514776060`, `+19513958776`, `+19514254567`, `+19517177772` — **real SoCal business lines**. Hard-blocked in the engine for good reason; they have no business being in a public repo. |
| `apps/api/src/portal/twilioNumbers.ts` | Same constant + Twilio account-level number management for the fleet. |
| `apps/owner-web/src/pages/admin/Numbers.tsx` | Assigns fleet numbers. |
| `packages/voice/*` (711-line bridge + 860 lines of tests) | Twilio Media Streams ↔ OpenAI Realtime. Tied to the SoCal voice stack and Cardinal Rule #3/#5. **Out of scope for CE 0.1** — Twilio is optional and operator-supplied, and CE does not ship a voice receptionist. |
| `packages/channels/*` | Twilio SMS send/validate. Deferred with voice. |
| `docs/receptionist.md`, `docs/restaurant-test-transcript.md`, `docs/failure-drills.md` | SoCal operational runbooks + a real customer transcript. |
| `scripts/onboard.mjs`, `provision-tenant-user.mjs`, `drills.mjs`, `reception-drill.mjs`, `restaurant-test.mjs`, `second-factor.mjs`, `jsonb-repair.mjs`, `connect-google-calendar.mjs`, `seed.mjs` | Operate the SoCal fleet against production. |
| `scripts/deploy.sh` | Deploys to `claw` (`10.10.1.3`). CE never deploys anywhere. |
| `Caddyfile` (`engine.heyjosi.com`) | Hosted hostname. CE ships a generic domain-templated Caddyfile. |
| `exports/*.json` | **Real tenant exports containing customer data.** Never leaves the engine repo. |

### 3c. Hosted infrastructure — excluded

| Source | Reason |
|---|---|
| `packages/db/apply.mjs` | Supabase Management API migration runner. CE uses direct Postgres. |
| `apps/api/src/portal/observability.ts` (Sentry) + `analytics.ts` (PostHog) | Third-party telemetry, always-on. CE telemetry is **opt-in, anonymous, self-hosted-reported** (map 98). Rebuilt, not ported. |
| `packages/mail/*` (Resend) | Hosted transactional mail. CE uses two operator-configured **SMTP** profiles (map 34). |
| `apps/owner-web/src/lib/observability.ts` | Browser Sentry/PostHog init. |
| `docker-compose.yml` (claw) | Single-host compose bound to `127.0.0.1:8110` behind a Cloudflare tunnel. CE ships a modular, profile-based compose. |

### 3d. Secrets and config that must never cross

Verified absent from what CE imports. Enforced by a pre-commit secret scan.

- `/Volumes/josi/Projects/josi-engine/.env` — production `DATABASE_URL` (Supabase),
  `TWILIO_*`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `RESEND_API_KEY`,
  `SENTRY_DSN`, `POSTHOG_KEY`, `CREDENTIALS_KEY`, `GOOGLE_CLIENT_*`,
  `INTERNAL_API_TOKEN`. **Not copied. Not referenced. Not templated from.**
- `engine.heyjosi.com` / `app.heyjosi.com` / `control.heyjosi.com`, `10.10.1.3`,
  `143.110.236.218` — production endpoints. CE config is domain-agnostic.
- The Cloudflare tunnel token visible in the engine's deployment.
- Supabase project ref `xcngpfeuvvcsxgwyukch`.
- Any `exports/*.json` tenant dump.

CE's `.env.example` contains **names and empty values only**.

---

## 4. Migrations: one workspace, many users

The engine's 7 migrations assume `tenants`. CE starts from a fresh `0001` rather
than shipping the engine's history — a self-hoster should not inherit a schema
archaeology of a business they are not part of.

**Table changes from the engine schema:**

| Engine | CE | Note |
|---|---|---|
| `tenants` (many rows) | `workspace` (exactly one row, enforced by a `check (id)` singleton like the engine's `app_settings`) | Business profile, timezone, settings live here. |
| `users.tenant_id` | `users.role` ∈ `super_admin` \| `member` | One super admin, enforced by a partial unique index. |
| `licenses` | *dropped* | |
| `caps (tenant_id)` | `caps` global + `user_caps (user_id)` | map 87: installation cap + optional per-user. |
| `tool_credentials (tenant_id, tool_key)` | `connections (user_id, provider)` | map 29–30: **each user connects their own account**. |
| — | `folder_mappings (owner_user_id, …)` | new; map 45–50 |
| — | `folder_shares (mapping_id, user_id \| workspace)` | new; map 68–69 |
| — | `documents`, `document_chunks`, `document_versions` | new; map 51–65 |
| — | `setup_state` | new; wizard progress + completion |
| — | `smtp_profiles` (2 rows: `system`, `communications`) | map 34 |
| — | `llm_providers` (primary + optional fallback) | map 82–86 |
| — | `telemetry_state` | map 98, opt-in |
| — | `install_identity` (one random UUID) | map 111 — **not** hardware-derived |
| `email_approvals`, `email_sends` | kept, `tenant_id → workspace`, `+ owner_user_id` | approval + exactly-once survive intact |
| `oauth_states` | kept, `+ user_id` already present | |
| `events` | kept as the audit trail; `+ retention policy` | map 73 |

**Rows that gain `owner_user_id` and a share check:** `connections`,
`folder_mappings`, `documents`, `email_threads`, and — **corrected in Phase 5** —
`contacts`, `tasks`, `threads`.

> ~~Everything else (`contacts`, `tasks`, `threads`) is workspace-shared,
> matching how the engine already behaves within one tenant.~~
>
> **This was wrong, and Phase 5 changed it.** The reasoning above holds inside a
> tenant because a tenant *is* one business speaking with one voice. A CE
> workspace is not: it is several people who happen to share an installation.
>
> The canonical map says the same thing in every neighbouring feature —
> operational email threads are "visible only to the user who initiated the
> conversation by default", mapped folders and their indexes are "private to the
> owning user by default", and "neither workspace membership nor super-admin
> status automatically grants content access". A member's conversation with Josi
> carries whatever they told it, which is exactly the material those lines
> protect. Shipping it workspace-readable would have made the one table nobody
> argued about the leak.
>
> `messages` deliberately carry no owner of their own: they are reachable only
> through their thread, so a share cannot be half-applied. Recorded in
> `PHASE_5_EVIDENCE.md`.

---

## 5. Connectors: adaptable, with the credential source inverted

The engine's connector code is provider-neutral already (`CalendarProvider`,
`MailProvider`) and is the single largest reuse win. What changes is **whose
OAuth client it is**.

| | engine | CE |
|---|---|---|
| OAuth client | SoCal's, in the engine's `.env` | **the operator's own**, entered in the setup wizard, encrypted in Postgres (map 28, 100) |
| Redirect URI | `engine.heyjosi.com/...` | `https://<operator-domain>/api/integrations/<provider>/callback` |
| Who authorises | the tenant | **each user separately** (map 29) |
| Token storage | `tool_credentials(tenant_id)` | `connections(user_id)`, encrypted with the installation master key |
| Scope grant | all requested at once | **incremental**: read first, re-consent for write (map 32) |

Reusable nearly verbatim: `google/gmail.ts`, `google/calendar.ts`,
`microsoft/mail.ts`, `microsoft/calendar.ts`, `mail.ts`, `calendar.ts`,
`booking.ts`, `http.ts`, `html.ts`, `emailApprovals.ts`, `oauth/state.ts`.

Rewritten: `registry.ts` (reads operator config from the DB, not env),
`connections.ts` (per-user, incremental scopes), `integrationRoutes.ts`
(per-user authorisation + super-admin deny-only policy).

**Twilio:** optional, operator-supplied, and **not wired in 0.1**. The voice
stack does not come across.

**Box / Dropbox:** map 46 permits them *later*. Per the prompt, they appear only
as clearly disabled "Coming soon" entries — no fake connectors.

---

## 6. What CE builds that the engine has no equivalent for

These are new, not extractions. Listed so the plan is honest about size.

- Setup wizard (host checks → owner account → domain/HTTPS → LLM → 2× SMTP →
  connectors → security/privacy → telemetry opt-in → review).
- Modular Docker Compose: web/API, worker, Postgres, Caddy; **profiles** for OCR
  and ClamAV, off until enabled (map 52, 56).
- LLM provider abstraction with capability probing — chat, structured output,
  tool calling, context length — gating dependent features (map 86).
- Local-only mode with a persistent badge (map 90).
- Document storage subsystem: mappings, scopes, indexing, OCR queue, ClamAV
  hook, history/versions, recycle bin, purge-on-revoke (map 45–79).
- Backup (encrypted, restorable, includes history copies) + data export
  (portable, excludes them) (map 63, 100).
- Diagnostics bundle: redacted, secret-scanned, user-inspectable, ≤25 MB, with
  1h/24h/7d windows (map 102, 109, 112–113).
- Support gateway *contract only* — no Zammad credentials in CE (map 115).
- Update check + one-click approved update with pre-update backup and rollback.
- Telemetry client, off by default (map 98).

---

## 7. Things that look reusable and are not

Called out because copying them would be the easy mistake.

- **`gate.ts` wholesale.** Half of it is licensing. CE keeps cap enforcement and
  workspace pause; `no_license` must not survive into a free product.
- **`adminRoutes.ts`.** Superficially "the admin API", actually fleet management.
  CE's admin surface is policy: capabilities, approvals, SMTP, LLM, quotas — and
  it is **deny-only** over user consent (map 31, 47).
- **`blockAdminWrites` semantics.** The engine forbids an operator writing into a
  tenant. CE needs something stronger and different: the super admin must not
  *read* user content either, which the engine never had to enforce.
- **`recall`'s embeddings path.** Defaults to an external embeddings provider.
  CE defaults to Postgres FTS and must forbid the external path in Local-only
  mode (map 51, 90).
- **The engine's `docker-compose.yml`.** Written for one known host behind a
  tunnel; CE's must be portable, multi-arch, and profile-gated.

---

## 8. Risks this map creates

| Risk | Mitigation |
|---|---|
| Per-user isolation is a *new* axis; a missed check leaks one user's mail to another | One `requireOwnerOrShared()` decision point; over-the-wire isolation tests per resource, mirroring the engine's `portal.test.ts` discipline |
| Super admin accidentally gains content access through an admin endpoint | Every admin endpoint returns metadata-only DTOs; tests assert no body/subject/filename fields appear |
| Copying a file that quietly imports `licenses`/`onboarding` | CE has no such modules; the build fails rather than silently including them |
| A SoCal phone number or endpoint reaching a public repo | Pre-commit secret + string scan for the four numbers, `heyjosi`, `socal`, the two IPs, `supabase` |
| Scope creep into voice/SMS | Voice and channels are excluded at the package level, not per-file |
