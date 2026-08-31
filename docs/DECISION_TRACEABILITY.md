# Decision traceability — canonical map → implementation

Source of truth: `/Volumes/josi/Projects/memory/2026-08-30.md`.

Every CE-relevant decision in that file appears here with its own row. IDs are
`M<line>` referring to the line in the canonical map, so any row can be checked
against the original wording. Nothing is collapsed into a generic TODO.

**Status values**
- `Done` — implemented and covered by a named test
- `Phase N` — accepted, scheduled, not yet built
- `Deferred` — deliberately out of 0.1, with a reason
- `Excluded` — a decision that resolves to "do not build this"
- `N/A` — the decision is not about CE

Status accuracy matters more than a full column of ticks. A row that says
`Phase 9` is a promise, not an achievement.

---

## A. Identity, licensing, branding

| ID | Decision | Status | Where |
|---|---|---|---|
| M7–M10 | Official Josi identity: orange/gold shepherd on navy, white `J` blaze, tennis-ball dot on the `i`. Approved artwork is the master; do not regenerate or substitute. | Phase 0/6 | Assets copied byte-identical from `josi-engine/apps/owner-web/public/brand/`. Test: asset checksum matches source. |
| M8 | Product line "Josi. Fetching what's next." | Phase 6 | Marketing copy in `README` + web app footer. |
| M26 | Branding is Josi throughout; not "powered by SoCal"; SOCAL RECEPTIONIST LLC is named creator/publisher; **CTF Designs must never be presented as creator**. | Phase 0 | `NOTICE`, `README`, app footer. Test: `scan-secrets.sh` also greps for `CTF Designs` appearing as creator. |
| M81 | License is **AGPL**; separate trademark/branding terms; official name/logo mandatory in CE and **not replaceable by self-hosters**; exact wording still to be drafted/reviewed. | Phase 0 | `LICENSE` (AGPL-3.0), `TRADEMARK.md`, both marked **DRAFT — REQUIRES LEGAL REVIEW**. Branding non-replaceability enforced in Phase 6 and stated in `TRADEMARK.md`. |
| M25 | One workspace per installation; multi-workspace requires contacting SOCAL RECEPTIONIST LLC for white-label or hosted. | Phase 1 | `workspace` singleton table; `README` states the boundary. |
| M95 | Release label **Josi CE 0.1 — Community Preview**. | Phase 0 | `package.json` version + `README` title. |

## B. Scope boundaries

| ID | Decision | Status | Where |
|---|---|---|---|
| M27 | No SoCal secrets, tenant data, or infrastructure credentials may ship. | Done | `.gitignore`, `scripts/scan-secrets.sh`. Test: fixture containing a SoCal number fails the scan. |
| M66 | Audio/video transcription and media indexing explicitly **out of scope** for the first release. | Excluded | Not built; `README` says so plainly. |
| M92 | CE includes **no support entitlement**; paid support pricing/package deliberately deferred. | Deferred | Reason: support is not going live and does not block CE. `README` states no SLA. |
| M93 | Initial commercial market is SMB only; do not design or market enterprise features. | Excluded | No enterprise/fleet/white-label surface exists in CE. |
| M94 | Publish CE while the hosted product is incomplete; treat feedback as product evidence, not obligation. | N/A | Release-strategy decision, no code. |
| M101 | Companion apps labelled **Coming soon**; no fake download/install actions before a real build exists. | Phase 6 | Apps page renders disabled entries. Test: no enabled download control present. |
| M123 | Future app discovery is email-first. Super admin allowlists an email; CE registers only an opaque email-to-instance route with the Josi directory; credentials authenticate directly against the discovered CE HTTPS endpoint; paired devices cache the endpoint and survive directory outages; device sessions are individually revocable; manual URL is Advanced only. | Deferred | Applies when companion apps ship. Security tests must prove the directory cannot observe passwords/content, duplicate local usernames across instances do not collide, unapproved emails cannot pair, endpoint responses are authenticated, and existing paired devices operate while the directory is unavailable. |
| M4 | Josi mobile releases built **locally only**; no Expo/EAS cloud builds or OTA. | N/A (0.1) | No app binaries in CE 0.1. Recorded so it binds when apps ship. |
| M13–M14 | Native workspace parity (all tenant pages on mobile). | Deferred | Applies to the companion apps, which are Coming soon in 0.1. |
| M117–M122 | Logo redesign paused; "pin it all until I get home". | Superseded | M7–M10 locked the identity on the same date; this prompt explicitly authorises CE work. |
| M24 | "Mapping only; do not create the repo until Roman explicitly authorises." | Superseded | This prompt is that authorisation. |

## C. Users, roles, authorisation

| ID | Decision | Status | Where |
|---|---|---|---|
| M96 | One workspace, **multiple users**, no artificial seat cap; real limits depend on hardware; document plainly. | Phase 1 | No seat check anywhere. `README` capacity section. |
| M97 | Capacity tiers must come from **real benchmarks**, not estimates; test Pi-class ARM64, old x86-64, modern mini-PC; document workload. | Deferred | Reason: no benchmark hardware run yet. **CE must publish no capacity numbers until then.** Enforced by review, not code. |
| M30 | Each user controls their own connected accounts. Owners may see connection **health** and revoke, but must not browse that user's email or calendar content. | Phase 7 | `requireOwnerOrShared()`; admin DTOs metadata-only. Test: admin connection view contains no message fields. |
| M31 | Connected accounts start **read-only**; write capabilities separately enabled; destructive stays approval-gated. Admin policy is **deny-only** — may disable, never grant what the user has not consented to. A capability works only when user grants **and** admin allows. | Phase 7 | `effectiveCapability = min(userGrant, adminPolicy)`. Test: truth table incl. admin-cannot-grant. |
| M33 | Per write action: **Always ask** / **Ask only for risky** / **Allow routine automatically**; default Always ask; admin may force stricter, never looser. | Phase 7 | Approval-level resolver. Test: admin loosening refused. |
| M47 | Storage access dual-gated: admin approves mapping capability **and** user consents; admin may tighten, not grant. | Phase 9 | Same resolver as M31. |
| M48 | Folder-mapping approval exposes only provider, folder name/path, requester, requested permissions — **no browsing/preview/search/read**. | Phase 9 | Admin approval DTO. Test: no content fields. |
| M68 | Every mapped folder and its index is **private to the owning user**; workspace membership alone never grants access. | Phase 9 | `requireOwnerOrShared()`. Test: member B guessing member A's mapping id → 404. |
| M69 | Admin may disable sharing entirely and separately forbid workspace-wide "Share with everyone"; ordinary shares need no per-share admin approval. | Phase 9 | Policy flags. |
| M70 | Removing a user purges their private unshared mappings/derived data; shared ones require explicit transfer or purge — **never ownerless**. | Phase 9 | User-deletion routine. Test: shared mapping blocks deletion until resolved. |

## D. LLM

| ID | Decision | Status | Where |
|---|---|---|---|
| M82 | Launch families: OpenAI, Anthropic/Claude, xAI/Grok, self-hosted. | Phase 4 | Provider registry. |
| M84 | Self-hosted via generic **OpenAI-compatible** endpoint: base URL, optional key, model name (Ollama, vLLM, LM Studio, LocalAI). | **Done (Phase 4)** | One adapter serves openai/xai/openai_compatible. Endpoint guard allows loopback and LAN and blocks cloud metadata — a documented departure from the plan's wording, argued in `PHASE_4_EVIDENCE.md`. Runtime: a stub runtime on the container network was configured, probed and used. |
| M85 | One primary + one **optional, explicitly enabled** fallback; used only when primary unavailable/rate-limited; warns about cost and second provider. | **Done (Phase 4)** | Three conditions, all required: exists, activated, and the failure was retryable. Test: not used for a bad key (mutation M4 fails the suite). |
| M86 | Probe chat, structured output, tool calling, usable context before activation; unsupported → clear warnings and **disable dependent features**, never pretend. | **Done (Phase 4)** | Four ordered steps, chat fatal, structured output judged by parsing the reply. Null capability = unknown = off. A DB check constraint makes active-but-unprobed unrepresentable. Mutations M6-M9 all fail the suite. |
| M87 | Installation-wide monthly cost/token caps + optional per-user; warn at 50/80/100%; **hard stop** after 100% until raised. | **Done (Phase 4)** | Worst-of-workspace-and-user governs; checked before the call, so a blocked call never reaches a provider. The probe is exempt so a broken model can still be replaced. Runtime: blocked in real PostgreSQL. |
| M88 | Usage distinguishes exact provider-reported charges from **labelled estimates**; self-hosted reports tokens/latency with `$0 provider charge` and states hardware/electricity excluded. | **Done (Phase 4)** | Three sources — reported / estimated / none — never blended; there is no `totalCostUsd` field, and a DB constraint rejects a self-hosted row claiming a cost. Unknown price counts tokens and says so rather than under-counting. |
| M89 | Enabling an external provider requires an explicit acknowledgment that data leaves the server; CE must not imply self-hosting keeps everything local. | **Done (Phase 3)** | Wizard refuses an external provider without it; stored with a timestamp, and a DB check constraint makes an unacknowledged external row unrepresentable. Test: 6 falsy/coerced variants all rejected; mutation M7 fails the suite. |
| M90 | Hard **Local-only mode**: only self-hosted endpoints, no external fallback, blocks features that would send content externally, persistent visible badge. | **Done (Phase 4)** | Enforced in `buildProvider`, so the fallback path cannot smuggle a hosted provider in either. Runtime: 409, nothing written, key not stored. Badge is Phase 6. |
| M91 | No bundled model weights or inference runtime; connect to a separately managed service. | Phase 2 | Compose ships no model runtime. |
| M83 | Subscription-based OpenAI/Claude connection **only if** an officially supported path permits third-party self-hosted use. Never scrape sessions, reuse Claude Code/Codex credentials, or imply subscriptions include API usage. UI must distinguish API billing from subscription access and **auto-hide/disable when no compliant path exists**. | **Done (Phase 4)** | Three options listed, all `available: false`, with the reason stated rather than "coming soon". Naming one as a provider is refused with 400. No subscription auth code path exists to reach. |

## E. Mail

| ID | Decision | Status | Where |
|---|---|---|---|
| M34 | Two super-admin SMTP profiles: **System mail** (welcome/verify/invite/reset/security) and **Josi communications** (user-authorised operational mail). Separate servers/identities, or a **copy-from-system** option adjusting only sender address/name. Ordinary users cannot configure installation SMTP. | **Capture done (Phase 3)**; delivery Phase 8 | `smtp_profiles`, one row per kind by unique index. Copy-from-system stores its own sender identity and NO credential, so the password exists once. Passwords sealed. `verified_at` stays null — nothing has been sent. |
| M35 | Operational mail uses the initiating user's identity in display/reply ("Roman via Josi") while sending through the central profile; replies route back to that user's conversation, **not** a shared inbox. | Phase 8 | Test: inbound reply resolves to the initiating user. |
| M36 | Inbound via IMAP/provider API, super-admin allow/deny. The setting governs **availability**, not permission to read users' mail. | Phase 8 | Capability flag; no admin read path. |
| M37 | Threads visible only to the initiating user by default; another user only after explicit share/assign; neither membership nor super-admin status grants content access. | Phase 8 | `requireOwnerOrShared()`. Test: admin 403 on thread content. |
| M38 | Admin may see delivery **metadata** — initiating user, recipient, timestamp, state, sanitized error category — never subjects, bodies, attachments, replies. | Phase 8 | Metadata DTO. Test: asserts absence of subject/body. |
| M39 | Threads retained until the owner deletes them; admin may set a workspace maximum retention (e.g. 30d/1y/7y) with clear warning before automatic deletion. | Phase 8 | Retention policy + pre-deletion notice. |
| M40 | User-deleted threads → recoverable trash **30 days** default; admin may shorten or make immediate. | Phase 8 | Trash retention setting. |
| M41 | Josi mail must disclose AI authorship ("Sent by Josi, AI assistant for Roman"); wording customisable, **not removable**, must not imply human authorship. | Phase 8 | Disclosure injected server-side. Test: cannot be emptied. |
| M42 | Operational, not marketing: legitimate multi-person threads, group scheduling, CC and group addressing allowed; **no BCC blasting or list outreach**. | Phase 8 | Recipient-count + BCC policy. |
| M43 | Adding a recipient to an existing thread **always** requires the initiator's approval, showing who the newcomer is and exactly how much history will be exposed. | Phase 8 | Approval screen with history-exposure preview. Test: unapproved add refused. |
| M44 | Sending **any** attachment always requires explicit approval with a preview of the exact file, recipients and message — even when routine sending is automatic. | Phase 8 | Overrides approval level. Test: routine-auto still blocks attachments. |

## F. Storage, documents, indexing

| ID | Decision | Status | Where |
|---|---|---|---|
| M45 | Local access deny-by-default, limited to preapproved folders via named bind mounts/volumes; **no general host or home access**; setup maps each path to a label/purpose. | Phase 2/9 | Compose mounts + application allowlist (both required). |
| M46 | Drive and OneDrive permitted; Box/Dropbox later. Not account-wide — each user maps individual folders. Prominent warning about proprietary/secret/privileged/regulated material and LLM processing. | Phase 7/9 | Box/Dropbox appear only as disabled Coming soon. |
| M47 | Every mapped folder starts read-only; create/edit/move/delete separately granted; **delete always requires approval**. | Phase 9 | See §C M47. |
| M49 | Mapping ≠ indexing. Indexing is a separate choice with an LLM-processing warning. Both support **This folder and all subfolders**, shown plainly in user consent and admin approval. | Phase 9 | Explicit recursive scope in both screens. |
| M50 | Recursive scope automatically covers **subfolders created later**; UI must state the continuing scope, not imply current children only. | Phase 9 | Copy asserted by test. |
| M51 | Postgres **full-text search by default**; semantic/vector optional; external embeddings must disclose that text leaves the server; **Local-only forbids it**. | Phase 9 | Test: Local-only blocks external embeddings. |
| M52 | OCR bundled in the images, **disabled by default**, super-admin only; warn about CPU/memory/time especially on Pi-class hardware; users cannot override. | Phase 2/9 | `ocr` compose profile. |
| M53 | When enabled, eligible files processed by a **throttled background queue**; admin controls concurrency/resource limits and may restrict to configured hours. | Phase 9 | Worker schedule + concurrency settings. |
| M54 | Unmapping or revoking indexing **immediately deletes all derived data**: extracted text, OCR output, FTS entries, embeddings. | Phase 9 | Test: each artefact type asserted gone. |
| M55 | Admin controls indexing limits with hardware-aware defaults: max file size, allowed extensions, total index storage, per-user quotas. | Phase 9 | Settings + enforcement. |
| M56 | ClamAV optional, own container; hookup ships ready; admin chooses whether to deploy/enable rather than forcing RAM/CPU on low-end hosts. | Phase 2/9 | `clamav` compose profile. |
| M57 | A finding **blocks** indexing/opening/processing and alerts owner + admin. Josi must **not** move, quarantine, modify or delete the source. | Phase 9 | Test: file byte-identical after a finding. |
| M58 | Automatic definition updates are a super-admin setting, not forced; UI shows enabled state, installed version, last success, failures. | Phase 9 | Admin panel. |
| M59 | Two scan modes: **on access/indexing** (lower cost) or **every new/changed file**; both supported. | Phase 9 | Mode setting. |
| M60 | On change, index the newest version. History super-admin configurable: disabled / 1 / 2 previous versions; snapshots vs **downloadable recovery copies**; disclose storage+privacy impact; count toward quotas; purgeable; never retained after unmap/revoke. | Phase 9 | History settings + purge. |
| M61 | History/recovery needs no extra per-user consent beyond existing mapping/indexing consent; admin alone sets mode; policy must be plainly visible to affected users. | Phase 9 | Visible policy banner. |
| M62 | No application-level encryption for recovery copies; setup must say they inherit Docker volume/host storage security and recommend full-disk/volume encryption. | Phase 9 | Explicit warning text. |
| M63 | Full restorable backups **include** retained recovery copies; portable exports **exclude** them and carry only current portable data/files. | Phase 10 | Two distinct exporters. |
| M64 | Password-protected/encrypted documents skipped with a clear per-file notice; Josi never requests, retains or manages document passwords. | Phase 9 | Per-file skip reason. |
| M65 | ZIP/RAR/7z excluded by default; admin may enable **bounded** extraction with limits on recursion, expanded size, file count, inner types, time, and path safety; encrypted archives still skipped. | Phase 9 | Zip-bomb + traversal fixtures. |
| M67 | Answers grounded in documents cite file name/path plus the most precise locator (PDF page, sheet/cell, slide, heading), with **Open source** when the user still has access. | Phase 9 | Citation renderer. |
| M71 | Revoking access purges source-derived long-term memory and tool/cache data; already-sent chat messages are **not** silently rewritten, but their citations become unavailable. | Phase 9 | Test: recall cannot surface purged content. |
| M72 | Super-admin audit trail for mapping requests/approvals, permission and sharing changes, indexing/OCR actions, ClamAV findings, purges, recovery-copy downloads — **metadata only**, never text/content/previews. | Phase 9 | Audit writer. Test: no content fields. |
| M73 | Audit retention configurable 30d/90d/1y/forever; default **1 year**; "forever" shows a storage-growth warning. | Phase 9 | Setting + warning. |
| M74 | Per-folder status: queued, processing, current, partially failed, paused; skipped-file reasons; progress; retry. Admin sees aggregate health/failure metadata without previews or extracted content. | Phase 9 | Status DTOs. |
| M75 | Global **Pause all document processing** stops new indexing/OCR/extraction/rescans without deleting built search data; existing search stays available. | Phase 9 | Global pause flag. |
| M76 | Local folders use filesystem watching; Drive/OneDrive use scheduled sync at admin-selected 5/15/30/60 minutes, respecting provider rate limits and hardware. | Phase 9 | Watcher + scheduler. |
| M77 | Rate-limited **Sync now** per user for their own cloud mappings; admin may disable manual sync globally; manual sync respects quotas and cannot bypass the global pause. | Phase 9 | Test: Sync now refused during global pause. |
| M78 | Expired/revoked provider access pauses the mapping and notifies the owner; admin sees connection-health metadata only — never names, previews or contents. | Phase 9 | Health DTO. |
| M79 | Source deleted while mapping remains authorised: recovery-copy mode keeps the last copy in a Josi recycle bin for admin-selected 7/30/90 days; without it, derived data purges immediately. Unmapping/revocation still purges immediately regardless. | Phase 9 | Recycle-bin retention. |

## G. Platform, packaging, operations

| ID | Decision | Status | Where |
|---|---|---|---|
| M80 | Database direction is **PostgreSQL only**. | Phase 1 | No other driver present. |
| M99 | Default distribution bundles **Caddy** for domain-based automatic HTTPS; advanced operators may disable it and bring their own proxy/TLS. | Phase 2 | `caddy` service + documented BYO mode. |
| M100 | Provider API keys, OAuth credentials, SMTP/Twilio secrets encrypted in Postgres with an installation **master key stored outside the database** as a Docker secret/file. Setup and backup docs must require backing up the key separately; DB backups alone cannot restore credentials. | Phase 2/3/10 | Master key as a Docker secret. Test: restore without the key fails loudly. |
| M28 | Google/Microsoft connectors require the **operator's own** OAuth apps/client secrets and callback configuration. | **Done (Phase 7)** | `oauth_clients`, secret sealed with the master key. CE ships no client of its own: a shared baked credential would let the first person to extract it impersonate every installation. The admin surface returns the client id (public, it travels in the authorize URL) and never the secret. Mutations M18/M19 fail the suite. |
| M29 | One owner-configured OAuth application per provider; every user connects and authorises their **own** account with separate encrypted tokens. | **Done (Phase 7)** | `connections(owner_user_id, provider)`, tokens sealed per connection. Wire tests: another member's connection is 404 to read, to enable a capability on, and to disconnect. |
| M32 | **Incremental authorization**: initial connection requests read scopes only; enabling send/edit requires reauthorization for write scopes. | **Done (Phase 7)** | Connect asks for read scopes only; enabling a write capability the provider never granted is refused with `needs_consent` rather than stored as a wish. A second consent accumulates scopes instead of narrowing the first. Mutations M4/M5/M7 fail the suite. |
| M98 | Telemetry **opt-in only**, at initial setup; may cover version, enabled features, aggregate counts, performance, errors; **never** prompts, message/email/contact/calendar content, credentials, secrets or identifiable business data. Setup explains exactly what is sent; off unless affirmatively enabled. | **Capture done (Phase 3)**; transmission Phase 10 | Only a literal `true` enables it; 8 falsy/coerced variants tested; DB constraint forbids enabled-without-consent. Nothing is transmitted — a test asserts the module contains no outbound call. Mutation M5 fails 7 tests. |
| M111 | One locally generated random UUID per installation for support correlation and rate limiting; **not** derived from hardware fingerprints, serials or MAC addresses, and not tied to mandatory telemetry. | Phase 1 | `install_identity`. Test: value is random, not hardware-derived. |

| M30 | Each user controls their own connected accounts; workspace owners may see connection health and revoke, but the admin panel must not let them browse that user's email or calendar content. | **Done (Phase 7)** | Admin view is username, provider, status, check time and a failure CATEGORY. Not the address, not the scopes, not a token. Mutation M17 — adding the account address to that query — fails the suite. |
| M33 (connector half) | Super-admin policy may tighten but never loosen; a capability works only when both the user grants it and the admin allows it. | **Done (Phase 7)** | `effectiveCapability` is the AND of provider-granted, admin-allows and user-enabled, with a full truth table and a monotonicity test. The policy table has an `allowed` column and no `granted` column — the shape itself cannot bestow. Mutations M1/M2/M6 fail the suite. |

## H. Support (contract only in 0.1)

| ID | Decision | Status | Where |
|---|---|---|---|
| M102 | Support page requires a problem description and a diagnostics ZIP; users inspect the bundle, consent explicitly, and pass a final secret scan. Bundles deleted 30 days after ticket closure; correspondence may remain. A ticket never grants remote access; screen-share/SSH arranged separately with temporary credentials. | Phase 10 | Local half built; gateway is contract only. |
| M103 | Gateway verifies the submitter's email with a one-time link before accepting a ticket or upload. | Deferred (gateway) | CE defines the contract; the gateway is SoCal-side and not in this repo. |
| M104 | Ticket categories: Bug report, Feature request, Paid support request, Security/privacy report — routed and prioritised separately. | Phase 10 | Category in the submission contract. |
| M105 | Diagnostics mandatory for bug reports and paid technical support; optional for feature requests; optional for security/privacy with a warning not to upload unrelated data. | Phase 10 | Form rules. |
| M106 | Correspondence works by verified email without a Zammad account; a customer-portal account may be optional. | Deferred (gateway) | Gateway-side. |
| M107 | Submission requires acknowledging that bug reports/feature requests carry no guaranteed response or fix, and that a paid-support submission is only a request to be contacted. | Phase 10 | Acknowledgment checkbox. |
| M108 | Public gateway uses Cloudflare Turnstile plus rate limits keyed by IP, verified email and installation ID. | Deferred (gateway) | Gateway-side; CE supplies the installation ID. |
| M109 | Bundles capped at **25 MB** compressed; exporter trims old logs and oversized/noisy files first. | Phase 10 | Size enforcement test. |
| M110 | Gateway quarantines and safely unpacks bundles, scans for malware, rejects executables, symlinks, traversal and zip bombs before forwarding. | Deferred (gateway) | Gateway-side. |
| M112 | Exporter offers 1-hour, 24-hour and 7-day log windows, defaulting to **24 hours**; every bundle includes version, container health, resource summary and sanitized config status. | Phase 10 | Exporter options. |
| M113 | Bundles **always exclude** prompts, chats, email/calendar/contact/task content, uploaded documents and database rows; users cannot toggle these in. | Phase 10 | Test: asserts absence. |
| M114 | Support backend is Zammad on `claw`, bound to `127.0.0.1:8111`, owner `roman@socalreceptionist.com`. | Excluded from CE | Infrastructure fact. **No Zammad credentials or host details in CE.** |
| M115 | Publish Zammad at `support.heyjosi.com` via the existing tunnel. CE must not embed Zammad credentials; submission goes through a narrow SoCal-controlled gateway. | Excluded from CE | CE knows only an abstract gateway URL, configurable and unset by default. |

---

## Open items requiring a human

1. **Legal review** of `LICENSE`, `TRADEMARK.md`, `NOTICE` — generated drafts,
   explicitly not approved wording (M81).
2. **Benchmarks before any capacity claim** (M97). No numbers ship until a Pi,
   an old x86-64 box and a modern mini-PC have been measured.
3. **Provider terms re-check** for M83 before ever enabling a subscription
   option.
4. **Support gateway** is a separate SoCal-side project (M103, M106, M108, M110,
   M114, M115); CE ships only the client contract.
