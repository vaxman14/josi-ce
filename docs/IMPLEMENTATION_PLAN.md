# Josi CE 0.1 — Community Preview: implementation plan

Phases are ordered so that **isolation and secrets come before features**. Every
phase has acceptance criteria that are testable, not aspirational, and a stated
risk. A phase is not done until its tests pass and the diff has been scanned.

Traceability to the canonical map lives in `DECISION_TRACEABILITY.md`. Extraction
decisions live in `EXTRACTION_MAP.md`. Neither is summarised away here.

---

## Phase 0 — Repository, guardrails, documentation ✅

**Goal:** a private repo that physically cannot leak SoCal material.

- `.gitignore` covering `.env*`, `secrets/`, `master.key`, `data/`, `uploads/`,
  `backups/`, `diagnostics/`.
- `scripts/scan-secrets.sh` — blocks the four SoCal phone numbers, `heyjosi`,
  `socalreceptionist`, the two production IPs, the Supabase project ref, and
  generic key shapes (`sk-`, `AKIA`, PEM headers, JWTs).
- The three docs: extraction map, this plan, decision traceability.
- Draft legal: `LICENSE` (AGPL-3.0), `TRADEMARK.md`, `NOTICE`, each marked
  **DRAFT — REQUIRES LEGAL REVIEW**.

**Acceptance:** `scripts/scan-secrets.sh` exits 0 on a clean tree and non-zero
when a SoCal string is introduced (tested with a deliberate fixture).
**Risk:** a false sense of safety from a scanner that is never run → wired into
a pre-commit hook *and* CI, not documentation.

---

## Phase 1 — Workspace + user model, auth, isolation

**Goal:** the security spine. Nothing else is built on sand.

- Migration `0001_workspace.sql`: `workspace` (singleton), `users`
  (`super_admin` | `member`, partial unique index on super admin), `sessions`,
  `auth_tokens`, `login_attempts`, `events`, `install_identity`, `setup_state`.
- Port `packages/auth` (argon2, opaque sessions, rate limiting) with
  `tenant_id` removed.
- `scopeWorkspace()` — the single decision point.
- `requireOwnerOrShared()` — the **new** axis: private-by-default resources.
- `requireSuperAdmin()` — policy only; a companion `assertNoContentAccess()`
  DTO helper for admin responses.
- CSRF (double-submit + `SameSite=Lax`), secure cookie flags, session rotation.

**Acceptance:**
- Over-the-wire tests: anonymous → 401 on every protected route; member cannot
  reach any `/api/admin/*`; **member A cannot read member B's private resource
  by guessed id**; super admin gets 403 on content endpoints, 200 on metadata.
- CSRF: a cross-origin POST without the token is refused.
- Exactly one super admin can exist (DB constraint proven by test).

**Risk:** per-user isolation is new — a missed check is a mail leak between
colleagues. Mitigated by one helper + a test per private resource type.

---

## Phase 2 — Packaging: Docker Compose, Caddy, health, multi-arch

**Goal:** `docker compose up` produces a working, HTTPS-terminated install.

- Services: `web` (API+SPA), `worker`, `postgres`, `caddy`.
- Profiles: `ocr`, `clamav` — **not started** unless enabled.
- Master key as a Docker **secret/file**, never an env var, never in the DB.
- `/health` (liveness) and `/ready` (DB + migrations + master key present).
- Multi-arch build: `linux/amd64`, `linux/arm64`.
- Bring-your-own-proxy mode documented, Caddy disabled by a profile.
- Non-root containers, read-only rootfs where possible, dropped capabilities.

**Acceptance:** clean `up` on amd64 and arm64; `/ready` red before migrations,
green after; OCR/ClamAV containers absent from `docker ps` when disabled; image
sizes recorded (no capacity claims — map 97).
**Risk:** ARM64 image bloat on low-end hosts → measure and record sizes; heavy
services stay opt-in.

---

## Phase 3 — Setup wizard

**Goal:** first-run experience, and the only path that creates the super admin.

Steps: host checks → owner account → domain/HTTPS → LLM → SMTP ×2 →
connectors (optional) → security/privacy → telemetry opt-in → review/finish.

- Wizard is reachable **only** while `setup_state.completed = false`; afterwards
  it 404s.
- Writes encrypted secrets through the master key.

**Acceptance:** a fresh DB serves the wizard and refuses all other routes; after
completion the wizard is gone and cannot recreate a super admin; a half-finished
wizard resumes at the right step; telemetry is off unless affirmatively ticked.
**Risk:** the wizard is an unauthenticated super-admin factory → single-use,
state-machine gated, and bound to the install identity.

---

## Phase 4 — LLM providers

**Goal:** OpenAI, Anthropic, xAI, and OpenAI-compatible self-hosted.

- Primary + optional explicit fallback (map 85).
- Capability probe: chat, structured output, tool calling, context length —
  results stored; dependent features disabled with a clear reason (map 86).
- Caps: installation-wide + per-user, warn at 50/80/100%, hard stop (map 87).
- Usage: exact provider charges vs **labelled estimates**; self-hosted reports
  `$0 provider charge` (map 88).
- Local-only mode: blocks external providers and fallback, persistent badge
  (map 90).
- External provider activation requires an explicit acknowledgement (map 89).
- **Subscription options:** built as a capability-gated choice that stays
  **hidden/disabled** because no compliant provider-supported path exists today.
  No session scraping, no Claude Code/Codex token reuse (map 83).

**Acceptance:** probe failures disable the right features; caps hard-stop at
100%; Local-only refuses an external provider at the API layer, not just the UI;
subscription option renders disabled with an honest explanation.
**Risk:** SSRF via the self-hosted base URL → allowlist scheme/port, block
link-local/loopback/metadata ranges, no redirects.

---

## Phase 5 — Assistant core

**Goal:** Josi actually works. Port the engine's product.

- `packages/core`: tasks, events, locks, queue, authority, second factor,
  metering, metrics.
- `packages/agent`: owner agent + provider adapter over Phase 4.
- Migration `0002_assistant.sql`: tasks, threads, messages, contacts, holds,
  approvals, usage ledger.

**Acceptance:** the engine's task-state-machine and authority tests pass against
CE's schema; approval gates behave identically.
**Risk:** silent behaviour drift while removing `tenant_id` → port the engine's
tests alongside the code.

---

## Phase 6 — Web app

**Goal:** the tenant workspace UI, mobile-first, official Josi branding.

- Dashboard, Talk, Tasks, Approvals, Conversations, Contacts, Business profile,
  Connections, Usage; admin section for policy.
- Companion apps page: **Coming soon**, no fake download actions (map 101).
- Branding mandatory and not replaceable (map 81).

**Acceptance:** Playwright at 320/375/390/430 — no horizontal overflow, controls
≥44px, keyboard navigable; no placeholder presented as working.
**Risk:** regressing the engine's iPhone Talk behaviour → port the WebKit
touch-send test with it.

---

## Phase 7 — Connectors

**Goal:** Google + Microsoft, operator's own OAuth client, per-user auth.

- Operator client id/secret from the DB, encrypted (map 28).
- Per-user connection + tokens (map 29–30).
- **Incremental scopes**: read first, re-consent for write (map 32).
- Per-write-action approval level: Always ask / risky only / routine automatic;
  default Always ask; admin may tighten, never loosen (map 33).
- Admin sees connection health, can revoke, **cannot browse content** (map 30).
- Box/Dropbox: disabled "Coming soon" entries only.

**Acceptance:** admin endpoints return no message/event content; a user cannot
act on another user's connection; enabling send forces re-consent; admin
tightening overrides user preference but admin loosening is refused.
**Risk:** deny-only policy inverted by accident → an explicit
`effectiveCapability = min(userGrant, adminPolicy)` function with a truth-table
test.

---

## Phase 8 — Mail: SMTP profiles + operational email

**Goal:** two profiles, identity-preserving sending, optional reply ingestion.

- `System mail` and `Josi communications`, copy-from-system option with a
  distinct From identity (map 34).
- "Roman via Josi" display identity, replies route to the initiating user's
  conversation (map 35).
- Optional inbound (IMAP/API), super-admin gated capability that grants **no**
  content access (map 36).
- Threads private to initiator; sharing is explicit (map 37).
- Admin sees delivery metadata only (map 38).
- Retention + 30-day trash, admin-configurable (map 39–40).
- Mandatory AI disclosure, wording customisable, not removable (map 41).
- Operational-only: multi-recipient threads yes, BCC blasting no (map 42).
- New recipient on an existing thread → approval showing exactly what history is
  exposed (map 43).
- Attachments always require approval with a preview (map 44).
- Loop prevention.

**Acceptance:** admin metadata view asserted to contain no subject/body; adding
a recipient without approval is refused; attachment send without approval is
refused; a reply loop terminates.
**Risk:** an unowned shared inbox forming → every inbound message resolves to an
initiating user or is quarantined.

---

## Phase 9 — Documents and storage security

The largest phase. Default deny throughout.

- Local: Docker bind mounts **plus** an application allowlist (map 45).
- Cloud: Drive/OneDrive, per-folder mapping, not account-wide (map 46).
- Read-only start; create/edit/move/delete separately granted; delete always
  approved (map 47).
- Dual gate: admin approves mapping capability **and** user consents (map 47).
- Admin approval sees metadata only (map 48).
- Indexing is a separate consent; recursive "and all subfolders" scope shown
  plainly and covering future children (map 49–50).
- Postgres FTS default; optional semantic indexing with an explicit
  data-leaves-server disclosure; forbidden in Local-only (map 51).
- OCR bundled, off by default, admin-only, throttled, hour-restricted (map 52–53).
- Purge on unmap/revoke: text, OCR output, FTS rows, embeddings (map 54).
- Admin limits: file size, extensions, total storage, per-user quota (map 55).
- ClamAV optional container; finding blocks processing, never modifies the
  source; admin-controlled definition updates; two scan modes (map 56–59).
- Document history: off / 1 / 2 versions; snapshots vs recovery copies; storage
  warning; quotas; purge (map 60–62).
- Encrypted/password-protected files skipped with a per-file reason (map 64).
- Archives excluded by default; bounded extraction if enabled (map 65).
- Citations with precise locators + Open source (map 67).
- Private by default; explicit sharing; admin may disable sharing (map 68–69).
- User removal purges private data; shared data must be transferred or purged
  (map 70).
- Revocation purges derived memory; sent messages are not rewritten (map 71).
- Audit trail, metadata only, retention 30d/90d/1y/forever, default 1y (map 72–73).
- Per-folder status + admin aggregate health (map 74).
- Global pause that preserves existing search (map 75).
- Local watch; cloud scheduled sync 5/15/30/60m; rate-limited Sync now; admin
  may disable manual sync (map 76–77).
- Token expiry pauses the mapping and notifies the user (map 78).
- Recycle bin 7/30/90d in recovery-copy mode (map 79).

**Acceptance:** unmapping purges every derived artefact (asserted per artefact
type); admin endpoints expose no filenames or content; archive extraction is
bounded (zip-bomb fixture); path traversal rejected; ClamAV finding blocks but
leaves the file byte-identical.
**Risk:** the highest-risk phase — extraction, OCR and watching all touch
untrusted bytes. Each gets an explicit threat-model entry and a hostile fixture.

---

## Phase 10 — Backup, export, updates, diagnostics

- Encrypted restorable backup ZIP: data + config + uploads + history copies;
  master-key strategy documented and deliberate (map 63, 100).
- Portable human-readable export ZIP, excluding history duplicates (map 63).
- Update: never automatic; check stable channel; one-click approve; pre-update
  backup; health check; **roll back on failure**.
- Diagnostics ZIP: inspectable, redacted, secret-scanned, explicit approval,
  ≤25 MB, 1h/24h/7d windows, never prompts/content/rows (map 102, 109, 112–113).
- Support gateway **contract only** — no Zammad credentials (map 115).
- Telemetry client, opt-in, anonymous (map 98).

**Acceptance:** backup → wipe → restore reproduces a working install *including*
encrypted credentials given the master key, and demonstrably fails without it;
a failed update rolls back automatically; a diagnostics bundle is asserted to
contain no message/document rows.
**Risk:** a backup that cannot actually be restored → the restore test is the
acceptance criterion, not the backup test.

---

## Phase 11 — Hardening, threat model, release

- Threat model document covering setup, auth, connectors, mapped folders,
  archive extraction, OCR, ClamAV, backup/restore, update/rollback, diagnostics
  upload, LLM tool execution.
- Rate limiting, audit logging, upload/archive limits, SSRF defences,
  least-privilege containers.
- Full test sweep; image sizes and platforms recorded.
- `README` with fresh-install, upgrade, rollback, backup/restore steps.

**Acceptance:** every threat-model entry links to a control and a test or is
explicitly accepted with a reason.

---

## Resequenced 2026-08-30: "smallest secure runnable install" first

Roman resequenced delivery to reach a working product sooner **without weakening
Phase 1**. Order is now:

> **Milestone A (runnable install):** Phase 1 → 2 → 3 → **5** → **6**
> **Then, in dependency order:** Phase 4 completion → 7 → 8 → 9 → 10 → 11

Milestone A is done when a fresh Docker install can: boot, complete setup, create
multiple users, connect a supported LLM path, persist to PostgreSQL, and pass the
hostile authorization tests.

Phase 4 (LLM providers) is *partially* pulled into Milestone A — enough provider
support to satisfy "connect a supported LLM/API path" and the capability probe
that gates dependent features. Caps, fallback, usage attribution and Local-only
enforcement complete in Phase 4 proper, after Milestone A.

Phase 9 (documents/storage) explicitly waits until the core product is
operational, as instructed.

Nothing in Phase 1 is deferred or softened by this resequence. It remains the
first phase and the gate on everything else.

## Sequencing rationale

Phases 1–3 are the trust boundary: model, packaging, setup. Nothing later can
fix a leak introduced there. Phase 4 precedes 5 because the assistant cannot be
tested without a provider abstraction. Phase 9 is last among features because it
depends on connectors (7), mail-grade approvals (8), and the storage/quota
policy surface built in 3.

## Deliberately not built in 0.1

Voice/SMS receptionist (Twilio optional and unwired), audio/video transcription
(map 66), plugin sideloading/marketplace, paid support packaging (map 92),
enterprise/white-label/fleet/hosted billing, Box/Dropbox connectors (Coming soon
only), companion app binaries (Coming soon only).
