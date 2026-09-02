# Josi CE — launch audit

The tracked record of the thirteen launch blockers raised against Josi CE, what
each one actually requires, and what has been **measured** rather than claimed.

This document is deliberately separate from `docs/IMPLEMENTATION_PLAN.md`. The
plan records intent and phase reasoning. This records the launch gate: a single
place where a blocker is either closed with named evidence or is not closed.

## How to read a status

| Status | Meaning |
|---|---|
| **DONE** | Implemented **and** proven by a named test, harness or measurement that has been run. |
| **BLOCKED** | Implemented as far as this environment allows; the remaining evidence needs an external dependency that is named in the row. |
| **NOT DONE** | Not implemented, or implemented without evidence. A screen, a saved setting, a mock-only test or a prose claim is NOT DONE. |

A row may not be marked DONE because a UI exists, because fields persist,
because a unit test with a mocked boundary passes, or because a document says
so. Those are the exact failure modes this audit exists to catch.

`SKIPPED` is never `PASS`. A harness that exits 3 because credentials were not
supplied has not tested anything, and its row says so.

## The blockers

| # | Blocker | Status | Evidence / what is missing |
|---|---|---|---|
| 1 | Appliance-simple Docker installation | **BLOCKED** | Built and unit-proven: `apps/api/test/installer.test.ts` (37). The published-image path, the preflight, the mode fix and the disk fix are all in and asserted, two of them by executing preflight's own helpers on this host. **Cannot close**: no Docker daemon and no N150 host here, so LB1.10 — the clean-install measurement from published artifacts — has not been run, and the images it pulls are not published yet. |
| 2 | Working ChatGPT subscription auth in clean Docker CE | **BLOCKED** | Built and unit-proven: `packages/llm/test/codexLogin.test.ts` (7) parses a byte-for-byte capture of the real `codex login --device-auth` output from `@openai/codex@0.152.0`; `apps/api/test/setupVerification.test.ts` (29) covers the wizard offer, the API-key refusal, the not-signed-in refusal and the capability-gated mounting; `apps/api/test/installer.test.ts` asserts the exact pin, the durable volume and the ownership. The CLI is pinned in the image, the login is driven from the wizard rather than from a shell the operator does not have, and `CODEX_HOME` is a dedicated volume in both compose files. **Cannot close**: LB2.4 (login survives container replacement) and LB2.10 (a clean install returns a real model response) both need a Docker daemon, and LB2.10 additionally needs ChatGPT credentials. Neither is available here. |
| 3 | Real, account-aware model selection | **DONE** | `packages/llm/test/discovery.test.ts` (31) plus the wire tests in `apps/api/test/setupVerification.test.ts`. `modelCatalog.ts` is deleted; models come from each provider's own listing endpoint, scoped to the credential supplied. Nothing falls back to a built-in list. Errors are categorized into eight kinds, with 429-plus-`insufficient_quota` distinguished from a plain rate limit. Curated labels are derived; exact IDs sit behind "Show technical details". |
| 4 | Setup must test everything it configures | **DONE** | `apps/api/test/setupVerification.test.ts` (23) and `apps/api/test/setup.test.ts` (55). A real model request that must return real content, a real SMTP send to an admin-chosen address or an explicit skip, and a real OAuth token-endpoint handshake per application. `/complete` refuses server-side while anything required is failing or untested. `/verify/:item` is the rerun control. |
| 5 | Complete Google and Microsoft onboarding | **BLOCKED** | Done and tested: org application registration is in the wizard (it previously claimed the flow was "not in this release"), the callback is generated from the HTTPS app URL rather than accepted from the client, LAN-only installations are told the domain requirement instead of being given an unusable callback, scopes are read-only by default, and the credentials now reach the table the connector system reads. LB5.6 is now verified against the blocker's wording over the wire — `apps/api/test/connectorHostile.test.ts` (21) walks Connect, status, scope display with each write permission's consequence, re-consent asking for only the new capability, revoke, disconnect, and recovery from a revoked connection healing the same row rather than creating a second. LB5.2 is asserted from both sides: a member cannot register the installation's application, and an administrator has no route to connect an account for anybody else. **Cannot close**: LB5.8 — two real users connecting real accounts — needs a Google Cloud project and a Microsoft Entra tenant. Every test injects `fetchImpl`; no provider has been contacted. |
| 6 | A real final review screen | **DONE** | `packages/core/test/setupReview.test.ts` (23) and the wire tests above. Five states, one pure function that cannot say "tested" without a passing verification, a headline computed from the same array it lists, per-item test/change actions, and no secret or ciphertext in the payload. |
| 7 | Correct post-setup admin flow | **DONE** | `packages/core/test/launchChecklist.test.ts` (29) plus RBAC sweeps in `apps/api/test/authorization.test.ts`. Ten derived items covering model, connectors, SMTP, users, approval policy, backups, master-key backup, security, diagnostics and updates. Critical items cannot be dismissed and a dismissal never hides a failure. The super admin is routed here once, then ordinary routing resumes. |
| 8 | Google and Microsoft contact synchronization | **BLOCKED** | Built end to end and proven against the real migrations: `packages/core/test/contactIdentity.test.ts` (25), `packages/connectors/test/contactAdapters.test.ts` (20), `packages/connectors/test/contactSync.test.ts` (41), `apps/api/test/contactSync.test.ts` (17) — 103 tests. Covers both providers, import-only and two-way, pagination, delta cursors and their expiry, tombstones, conflicts, retry/backoff, revoke, reconnect, merge/keep-separate, least-privilege scopes, and the two-user isolation criterion over the wire. **Cannot close**: no run against a real Google or Microsoft account has happened. `scripts/test-contacts-runtime.sh` exists for it; Part B exits 3 (SKIPPED) without credentials and Part A has never been executed because there is no Docker daemon here. Scheduled sync is now built and tested: a fan-out schedule enqueues one job per due origin, paced per account by attempt rather than by success, with worker-level isolation asserted separately — `apps/api/test/worker.test.ts` (15). |
| 9 | Native iOS and Android contact synchronization | **PARTLY DONE — not closed** | `docs/MOBILE_CONTACT_SYNC.md` is the server contract and handoff, and LB9.2 (cross-source dedup) is built and tested. Every endpoint in it is marked NOT BUILT and is specification. LB9.6 is **BLOCKED**: no mobile repository access and no physical device. The evidence table in that document is deliberately empty and must stay empty until a real device fills it. |
| 10 | Harden approval policy by default | **DONE** | `packages/core/test/approvalDefaults.test.ts` (27) on real migrations under PGlite. Fail-closed default, ten-class catalog, high-impact floor, confirmed-and-audited relaxation, and a migration that is idempotent, never overwrites a deliberate choice, and reports every ceiling it seeded. Server-side only; no client path can widen it. |
| 11 | Fix workspace and branding | **DONE** | `apps/api/test/branding.test.ts` (20). `git grep shepherd` finds nothing in any product surface and only labelled historical records elsewhere; the mark is now the white J cut from the approved wordmark by `scripts/build-brand.sh`; the "branding may not be removed" claim is withdrawn across `TRADEMARK.md`, `NOTICE` and `README.md`; and every Workspace outcome — ready, empty, error, timeout, unauthorized — is classified by a pure function that is tested exhaustively and is what the page calls. **Legal text needs counsel** (see below). |
| 12 | Hide plumbing without hiding truth | **DONE** | `apps/api/test/plainLanguage.test.ts` (32) asserts the property generally rather than per screen: **no page renders a bare database value**, checked across every `.tsx` under `apps/web/src/pages`, with template-literal interpolation and JSX attributes excluded because neither is text a person reads. The vocabulary in `apps/web/src/lib/plainLanguage.ts` is validated against the **CHECK constraints in the migrations** and against the `ErrorCategory` and `ProviderKind` unions, so a state added in SQL or in a type with no plain-language entry fails the suite. Copy controls are one shared `Copyable`; the redirect-URL override and the exact model identifier are behind labelled disclosures and remain reachable. LB12.4 is asserted directly — the external-data consent, the master-key warning, the connector-policy security text, the scope list and per-screen failure detail are all still present. The full technical explanation stays in `docs/INSTALLATION.md`, which gained §12A. |
| 13 | Banana | DONE | This row. See below. |

## 13 — Banana

**banana**

This row exists because a checklist item with no runtime behaviour is the
easiest kind to drop silently, and dropping it silently is indistinguishable
from dropping a real one. It was requested; it is preserved verbatim; it has no
product effect and no code path reads it.

If a future audit of this document finds this row missing, the process that
removed it also removes real requirements without saying so.

## Cross-cutting work

| Item | Status | Evidence / what is missing |
|---|---|---|
| Threat model covers the new surfaces | **DONE** | 18 entries added — T-51…T-68 — for contact synchronisation, subscription sign-in, setup verification and model discovery, and approval policy. `apps/api/test/threatModel.test.ts` **parses the document and fails the suite** if an entry names a control file that does not exist or a test that is not in the suite, so every one of the 18 is verified rather than asserted. 201 tests in that file, up from 147. |
| Hostile tests | **DONE** | OAuth state replay, callback confusion, token substitution and webhook replay are now written and passing: `apps/api/test/connectorHostile.test.ts` (21) covers replay, expiry, session mismatch, wrong-provider redemption, ownership from the stored handshake, cross-user connection ids, and CSRF; `apps/api/test/telegram.test.ts` (41) covers a redelivered update processed exactly once, a forged update for an unlinked chat, and a replay without the webhook secret. Earlier work covers cross-user contact leakage and IDOR, token exfiltration via a provider cursor, provider-prose leakage, setup step replay, and credential-store scraping. Threat-model entries T-69…T-72 cite these and are verified by the parser. |
| Backup, export and deletion cover the new data | **DONE, and now tested** | Checked rather than assumed, after an earlier draft of this row claimed the opposite twice and was wrong both times. **Backup**: `pgWriter.ts` runs `pg_dump` over the whole database with no table allow-list, so the four contact-sync tables are included automatically; the portable export excludes only `document_versions`, `document_embeddings` and `processing_jobs`, so contacts travel with it, which is what a portable export is for. **Deletion**: all four tables declare `owner_user_id … on delete cascade`, so removing a user removes their origins, links, tombstones and merge decisions. Both are now covered by `packages/core/test/dataLifecycle.test.ts` (16): the writer is asserted to take no table allow-list, the portable export's exclusions are checked against a list of derived artefacts only, and the cascade is proven by creating rows for two users across all five tables, deleting one user, and asserting their rows are gone and the other's are not. |
| Migrations re-runnable where they claim to be | **DONE** | The runner records every file in `_migrations` inside the transaction that applies it and skips what is already there, so most migrations are not idempotent and do not need to be — an earlier version of this row treated blanket idempotence as the requirement and was wrong. What is asserted: that the runner really works that way, and that every migration using `if not exists` genuinely re-runs. That caught 0020, which had `if not exists` on its tables and a bare `create trigger` underneath — a promise the file did not keep. |
| RBAC and audit events for the new surfaces | **DONE** | Contact sync is member-owned with no administrative route, swept anonymously and as another member in `apps/api/test/contactSync.test.ts`; sync events carry counts and categories only, asserted against names, addresses, numbers and provider ids. |
| Retention for contact data | **ACCEPTED, not built** | The retention sweep governs the audit log. Contacts are user data rather than a log, and Josi deletes them only when the user or the provider does — which is LB8.9's rule. No retention window applies, and none is claimed. |

## Environment limits recorded up front

These are properties of the machine this work was done on, not of the product.
They decide which rows can reach DONE here and which must be BLOCKED.

| Limit | Consequence |
|---|---|
| No Docker daemon on the development host (`docker` is not installed) | No clean-install acceptance, no container-replacement persistence proof, no image build measurement can be run here. |
| No ChatGPT subscription credentials | Codex device login and a real subscription model response cannot be completed here. |
| No Google Cloud project or Microsoft Entra tenant | Real OAuth application registration and handshake cannot be completed here. |
| No physical iOS or Android device | Native contact-sync device tests cannot be run here, and no mobile application source exists in this repository. |
| No Intel N150 / 16 GB host attached | The amd64 clean-install profile cannot be measured here. |

Every one of these appears as a named dependency in the row it blocks rather
than being absorbed into a summary.

## Decisions taken that a person should confirm

These were made in order to keep going rather than stop. Each is cheap to
reverse and none is hidden.

| Decision | Why | How to reverse |
|---|---|---|
| The mark is a white `J` on navy **cut from the approved wordmark** | The identity brief says "the white J on navy" and no such artwork exists in any repository reachable from here. Deriving it from the wordmark uses the approved letterform, colour and field rather than inventing a second one. | Drop an approved master over `apps/web/public/brand/josi-mark.png`, update the pinned hash in `scripts/test-web-runtime.sh`, and stop running `scripts/build-brand.sh`. |
| The tagline "Josi. Fetching what's next." is **retired** | It is a dog pun, and it belonged to the shepherd concept the brief retires. Replaced with "Your assistant, on your own server.", which the PWA manifest already used. | One string in `README.md` and one in `apps/web/src/pages/Login.tsx`. |
| The mandatory-branding condition is **withdrawn**, not reworded | It purported to restrict what the AGPL grants and inverted what trademark law asks of a fork. Keeping it would have meant shipping a term that fails on contact with anyone who reads it. | This is the question flagged to counsel as the most important one in `TRADEMARK.md`. It is a real weakening of the previous commercial position and should not be settled without a lawyer. |

## Legal text requiring counsel review

`TRADEMARK.md` and `NOTICE` are drafts written by an AI assistant. Neither is
legal advice and neither has been reviewed by a lawyer. The specific open
questions are marked `[REVIEW]` in `TRADEMARK.md`; the load-bearing one is
whether withdrawing the mandatory-branding condition is acceptable to the
business, and if not, what licensing structure would achieve the goal that a
trademark policy cannot.
