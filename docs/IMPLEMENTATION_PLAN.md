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

**Acceptance (met — see `PHASE_2_EVIDENCE.md`):**
- Clean `up` from a **clean, uniquely named Compose project** on a Docker
  daemon. *Not* a literally empty daemon: the host that could have provided one
  no longer exists, and emptying the available host would mean removing 24
  unrelated running containers. The project is torn down to zero
  containers/volumes/networks and asserted before each run, so what is proven is
  that CE installs with nothing of its own pre-existing.
- `/ready` green after migrations, and each blocker (`database`, `migrations`,
  `master_key`) proven independently. The red-before-migrations case is asserted
  against a stub database in the unit suite rather than by racing the migrator
  at runtime.
- OCR/ClamAV absent from `docker ps` when disabled, **and** the ClamAV image
  never pulled.
- Multi-arch manifest published to a private registry and proven to resolve per
  platform on pull.
- Image sizes recorded as **total** footprint, not the unique-layer figure
  `docker image inspect` prints. No capacity claims (map 97).

**Risk:** ARM64 image bloat on low-end hosts → measured: 372 MB total, of which
~286 MB is the Node base. Heavy services stay opt-in. A future phase should
evaluate an Alpine base, which would cut roughly 200 MB but requires musl
prebuilds for `@node-rs/argon2`.

**Risk realised:** profile coupling. Caddy was profile-gated so BYO-proxy could
be selected, which meant naming *any* profile dropped it — so the documented
command for enabling OCR took HTTPS offline. Required services now carry no
`profiles` key, asserted by test.

---

## Phase 3 — Setup wizard

**Goal:** first-run experience, and the only path that creates the super admin.

Steps: host checks → owner account → domain/HTTPS → LLM → SMTP ×2 →
connectors (optional) → security/privacy → telemetry opt-in → review/finish.

- Wizard is reachable **only** while `setup_state.completed = false`; afterwards
  it 404s.
- Writes encrypted secrets through the master key.

**Acceptance (met — see `PHASE_3_EVIDENCE.md`):** a fresh DB serves the wizard
and refuses all other routes (503, `setupRequired: true`); after completion every
setup route is 404 and cannot recreate a super admin; a half-finished wizard
resumes at the first incomplete step across a process restart; telemetry is off
unless affirmatively ticked. 124 static tests, 37 runtime checks, 8 mutations all
caught.

**Scope note:** Phase 3 delivers the setup API and its state machine. The
wizard's screens are Phase 6, with the rest of the web app.

**Risk (realised and handled):** the wizard is an unauthenticated super-admin
factory. Single-use, state-machine gated, bound to the stored install identity.
The single-use guarantee was initially UNTESTED — pglite serialises queries, so
an HTTP-level concurrency test could not reach the SQL latch. Fixed by extracting
`sealSetupOnce()` for direct testing and by proving genuine concurrency against
real PostgreSQL at runtime.

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

**Status: done.** 65 tests, 21/21 mutations caught, 47/47 runtime checks on a
real stack. See `PHASE_4_EVIDENCE.md`.

**Amended during the phase — SSRF.** "Block loopback" and M84's "cover Ollama,
vLLM, LM Studio" cannot both hold: those runtimes live on loopback and private
addresses. Only the super admin can set this value, and they already administer
the host, so the classic SSRF threat is absent. Cloud metadata is blocked on
every resolved address, redirects are never followed, and addresses are
re-validated at request time; loopback and LAN are allowed. Both directions are
tested.

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

**Status: done.** 109 tests, 26/26 mutations caught, 50/50 runtime checks on a
real stack. Migration is `0004_assistant.sql` (0002 and 0003 were taken by the
wizard and the LLM layer). See `PHASE_5_EVIDENCE.md`.

**Amended during the phase — two departures, both argued rather than applied
quietly.**

1. **Isolation.** `EXTRACTION_MAP.md` had `contacts`, `tasks` and `threads`
   workspace-shared, carried over from the engine. They are **owner-scoped**
   instead: a CE workspace is several people sharing an installation, not one
   business speaking with one voice, and the canonical map makes content private
   unless its owner shares it. The risk line above was right — this is exactly
   where drift would have hidden.
2. **Second factor.** The engine's PIN word answers caller-ID spoofing, which CE
   does not have. What ships is step-up **re-authentication** against a held
   session, named accurately. A genuine second factor (TOTP) is not built.

The engine's `authority.ts` inbound-routing tests could **not** port: they
resolve a caller by phone number to decide owner-vs-receptionist, and CE has no
voice channel. The second-factor gate's discipline ported in full; its factor did
not.

---

## Phase 6 — Web app

**Goal:** the tenant workspace UI, mobile-first, official Josi branding.

- Dashboard, Talk, Tasks, Approvals, Conversations, Contacts, Business profile,
  Connections, Usage; admin section for policy.
- Companion apps page: **Coming soon**, no fake download actions (map 101).
- The future native-app bootstrap is email-first: the super admin allowlists an
  email under **Approved app users**; CE publishes only an opaque routing record
  to the Josi directory; the app discovers the CE endpoint by email and submits
  the user's password directly to that verified HTTPS endpoint. The directory
  never receives passwords, sessions, messages, connector data, or tenant
  content. CE returns a device-specific revocable session. Paired devices cache
  the verified endpoint and continue operating directly during directory
  outages. Local usernames are not discovery keys because they can collide
  across installations. Manual URL entry is an Advanced fallback. Removing an
  approval and revoking already paired devices are separate explicit controls.
- Branding mandatory and not replaceable (map 81).

**Acceptance:** Playwright at 320/375/390/430 — no horizontal overflow, controls
≥44px, keyboard navigable; no placeholder presented as working.
**Risk:** regressing the engine's iPhone Talk behaviour → port the WebKit
touch-send test with it.

**Status: done.** 43/43 browser checks in WebKit with touch emulation, 28/28
runtime checks, 339 unit tests. The setup wizard's screens, which Phase 3
deferred here, are included. See `PHASE_6_EVIDENCE.md`.

**Amended during the phase — CE fetches nothing from anywhere.** The engine
loads fonts from a CDN; a self-hosted product doing that tells a third party the
IP of everyone who opens it, breaks air-gapped, and contradicts the Local-only
badge. CE uses the system font stack, and `default-src 'self'` makes that
checkable rather than a promise.

**The browser found a defect four phases of green suites had not.** The admin
model page crashed because Phase 4 wrote a jsonb column with `JSON.stringify`
and a cast instead of the `json()` helper — silent under pglite, permanent under
postgres.js. Verified that the unit suite *cannot* catch it by re-introducing
the bug; a static check on the shape now can.

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

**Status: done.** All four acceptance criteria proven over the wire and again at
runtime. 92 new tests (431 total), 24/24 mutations caught, 58/58 runtime checks.
See `PHASE_7_EVIDENCE.md`.

The named risk is answered by `effectiveCapability`, with the truth table asked
for plus a monotonicity test: from fully enabled, flipping any single input to
false makes the answer false. The policy table has an `allowed` column and no
`granted` column, so the shape itself cannot bestow.

**Two mutations were not caught first time**, and both are recorded rather than
quietly fixed: a callback that trusted `?user=` (latent — no test supplied one),
and the client secret's ciphertext being returned to the admin, which is the
same defect Phase 4's M18 exposed and which I failed to carry across.

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

**Status: done.** 522 tests, 31 of 31 mutations caught, 60 runtime checks on
claw. Evidence: `docs/PHASE_8_EVIDENCE.md`.

Runtime ran a **real SMTP server** on the project network rather than a stub, so
nodemailer's actual EHLO/DATA path executed and the test could read the bytes
that would have gone out: the From identity, the Reply-To routing token, the
disclosure, the loop-prevention headers, and the absence of a Bcc. No mail left
the host.

**Three defects worth remembering.** A message *fingerprint* was passed where
`requestApproval` expected a *payload*, so it hashed the hash and no approval
could ever match — every attachment and new-recipient send would have been
impossible in production. The unit test missed it by building approval rows by
hand; the wire test caught it. Mutation M14 exposed that `smtpTransport`, the
function production uses, was called by no test at all, leaving its error
sanitising unprotected — the worst place for it, since a bounce quotes the
message that bounced. And **M37 was only half built**: the ownership spine had
honoured shares since Phase 1, but no HTTP route could create one, so "private
unless shared" held only because sharing was impossible.

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

**Status: security spine done and verified; the machinery that touches real
bytes is not built.** 734 tests, **97 of 97 mutations caught**, **94 runtime
checks on claw with 0 failures**. Evidence: `docs/PHASE_9_EVIDENCE.md`.

Built in four cycles, and the first was entirely about the GRANT rather than the
parser — because a bad parser crashes and a bad grant quietly works. Containment
is normalise → structural check → resolve symlinks → check again, tested against
real symlinks including the sibling-prefix case (`docs-private` vs `docs`) where
the common `startsWith` answer fails. The dual gate is asymmetric: there is no
admin route into `createMapping`, so an administrator cannot map a folder for
somebody else and then read it out of the index they also run.

**Not built: parsers, OCR, a deployed ClamAV, cloud sync, filesystem watching,
embeddings, recovery-copy writing, and the storage screens in the web UI.** The
controls are in place and proven before anything is wired to them, which is the
right order for this phase — but an installation running this code can map a
folder and search nothing, because nothing fills the index.

Runtime verification took five runs and found two product defects the unit suite
could not: `npm ci` failing on a clean host because the lockfile never learned
about the new workspace, and a compose file with no `/data` mount at all —
nowhere to bind a shared folder and nowhere for a recovery copy to live.

Phase 1's append-only trigger refused the M73 retention sweep — the guard working
as designed. Rather than a bypass flag, the trigger now permits deleting only
rows already past the configured window.

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

**Status: done, with named shortfalls.** 827 tests, **49 of 49 mutations
caught**, **47 runtime checks on claw with 0 failures** — a real `pg_dump`, a
real schema drop, a real restore. Evidence: `docs/PHASE_10_EVIDENCE.md`.

The stated risk was exactly right. **819 unit tests passed against a backup
feature that was non-functional on a real installation for three independent
reasons**: production had no writer at all, the backup volume was root-owned
while the app runs as `node`, and `pg_dump` 15 refuses to dump a `postgres:16`
server. Each alone was fatal; none was visible to a unit test.

The mutation harness's own `assert_mutated` had never fired across Phases 7–10 —
it compared partial trees, so it always reported "mutated". Fixed, and it caught
a non-applying mutation within minutes.

**Not built:** no update has ever been applied (rollback is proven as logic, not
as a deployment); the portable export is a `pg_dump`, not the human-readable
export M63 describes; diagnostics collect no logs or container health because
the app has no Docker socket; restore does not verify an archive belongs to this
installation; and there is no backup retention or scheduling.

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

## Phase 12 — Identity, memory, and constrained behaviour

**Product doctrine:** *OpenClaw's soul, Apple's product discipline.* Josi CE
must feel personal, continuous, and owned by the person using it without
becoming an open-ended agent framework. The compiled CE core remains the final
authority for security, privacy, ownership, approvals, tool permissions,
auditing, and supported capabilities. No administrator setting, user setting,
Markdown file, memory, or current request may weaken those invariants, create a
new capability, or grant access.

- Per-user `SOUL.md`: assistant name, identity, relationship, tone, humour,
  communication style, and personal boundaries. Supply useful presets and a
  live response preview, but allow a fully custom personality (map new).
- Per-user `USER.md`: the person's self-description, preferences, names,
  locale, working style, and other user-maintained context (map new).
- Two constrained `AGENTS.md` layers: an installation policy controlled by the
  administrator and a per-user workflow profile. These may tune only choices
  the core explicitly exposes (proactivity, formatting, research behaviour,
  escalation preferences, and supported-tool workflow); they are not raw
  system-prompt extensions (map new).
- Per-user `MEMORY.md`: curated durable facts, separate from conversation
  history and from document/email recall. Users can view, add, edit, pin,
  confirm, and truly delete memories (map new).
- Optional automatic memory *suggestions* from conversations. The user chooses
  manual approval or an explicitly enabled automatic mode. Never retain raw
  passwords, tokens, payment data, or connected-source content by default.
- Every memory records provenance, creation time, last confirmation, and
  confidence. Revoking or deleting a source purges every derived memory while
  leaving unrelated conversation history intact (map new; extends map 71).
- Import/export all four portable Markdown files. The database is canonical so
  container replacement and upgrades cannot erase them. Round trips preserve
  content and versions (map new).
- Imported Markdown is untrusted data parsed into bounded configuration, never
  concatenated into an unrestricted privileged prompt. Reject unsupported
  fields, enforce size limits, and make ignored instructions visible to the
  user rather than silently pretending they applied (map new).
- Prompt assembly order:
  `immutable CE core → admin policy → user workflow policy → Soul/User context
  → relevant retrieved memory → current request`. Only relevant memories enter
  a turn; the whole memory file is not repeatedly stuffed into context.
- Settings surfaces for Soul, About me, Working style, and Memory, including
  version history, reset, import, export, and a precise explanation of what each
  layer can and cannot change.
- First-run personalization is optional and skippable. Defaults preserve the
  current brief/direct personality and the assistant works before any profile
  is created.
- Backup, restore, export, retention, deletion, audit, and ownership isolation
  cover all four profile types.

**Acceptance:** two users on one installation receive demonstrably different
personalities, workflow preferences, and memories without cross-user leakage;
import/export is an exact round trip; restart, backup/restore, and upgrade retain
all profiles; reset changes no conversations or unrelated memory; deleted memory
cannot be recalled; a hostile profile attempting to disable approvals, expose a
secret, access another user, invent a tool, or alter core policy has no effect
and the invariant tests prove it.

**Risk:** reproducing OpenClaw's unrestricted instruction-file semantics would
turn personalization into privilege escalation. CE deliberately reproduces the
personal *experience*, not the authority model.

**Status: done.** Every item in the phase text above is implemented and verified.
1088 tests, **56 of 56 mutations caught** across three scripts, and **133 runtime
checks on claw** in two suites — 68 for personalization and 65 for backup and
restore — with 0 failures. Evidence: `docs/PHASE_12_EVIDENCE.md`.

The one thing still unmeasured is upgrade retention, for the same reason as
Phase 10: nothing downloads a release, so "upgrade retains all profiles" follows
from the database being canonical rather than from a measurement.

A profile never becomes instructions: Markdown is parsed into a bounded
configuration of named fields with enumerated values, and `AGENTS.md` has no
free-text field at all. The load-bearing part is not the prompt — approvals,
ownership and tool permission are enforced by routes reading database rows,
outside the assembled string entirely, so a model persuaded by a hostile
personality still cannot act.

**Phase 12.1 closed the two gaps this originally left open.** Personalization now
reaches every live turn — core, authority note, admin policy, narrowed user
preferences, soul, user and relevant memory as the system context, with the
request in one user message — and every completed exchange runs a bounded
extraction that honours the person's memory mode. 1069 tests, **17 of 17**
additional mutations, **68 runtime checks on claw with 0 failures**, including
two people receiving different personalities in real model calls.

**Phase 12.2 built the rest of the phase text:** optional and skippable first-run
personalization, five presets, a live response preview that really calls the
model and stores nothing, version history surfaced in Settings with per-version
restore, and profile backup/restore measured on a real `pg_dump` → wipe →
restore rather than inferred. 1088 tests, **9 of 9** further mutations, **65
additional runtime checks on claw**.

**Every item in the Phase 12 text is now implemented.** The one thing still
unmeasured is upgrade retention, for the same reason as Phase 10: no update has
ever been applied, so "upgrade retains all profiles" follows from the database
being canonical rather than from a measurement.

The runtime run found the Phase 6 jsonb defect recurring in a package written six
phases later, which the static guard added after Phase 6 could not see because it
knew only one of the bug's two shapes.

**Release position:** first post-0.1 product phase. Phase 11 closes and hardens
the current 0.1 scope; Phase 12 then adds personalization as a separately tested
feature rather than expanding the release boundary during hardening.

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
