# P2 credential migration inventory

Source audit updated 19 October 2026. This is a work ledger, not a claim that Vault-only authority is complete. See [P2 evidence](P2_VAULT.md) for executed checks. No live user credentials were read during this inventory.

| Consumer | Canonical target / current checkpoint | Remaining work |
|---|---|---|
| Cardinal Rules | Existing Vault protected drafts/reviews/tests and permanent policy versions; exact-command administrator verification and guarded lifecycle tested | Protected native activation/retirement and UI/API coordination are assembled; final dispatch, revalidation, recovery reconciliation and functional acceptance remain open. |
| Telegram, Slack, WhatsApp | Owner-bound recoverable Vault references, transactional legacy import | Upgrade-wide migration before replacing an installation key. |
| Mobile push | Vault item per owner/device identity; registration and receipt fencing | End-to-end remote-client acceptance in P12. |
| Custom API | Vault item per connection; transactional import/rotation/deletion | P4 dispatch authority; full upgrade migration. |
| OAuth application credentials | Vault item per provider, stable owner; transactional migration and consumer regressions passed | Full upgrade migration. |
| Account-connection PKCE | Temporary Vault item per hashed state; transactional consumption, worker expiration cleanup and callback regressions passed | P12 upgrade/end-to-end acceptance. |
| Google web/native Josi login PKCE | Owner-bound temporary Vault references; one-use, recovery, native-return, lock and expiration tests passed | P12 upgrade/end-to-end acceptance. |
| MFA/TOTP | Recoverable Vault reference; transactional setup/enable/disable and ordinary MFA login, shared factor reader for Apple/parental authority | Full upgrade migration; P12 end-to-end recovery and reauthentication acceptance. Recovery-code hashes remain usable while locked; enabled MFA is never skipped because its key/secret is unavailable. |
| OAuth account tokens / Nextcloud | Strict Vault writes, transactional import/rotation/refresh/reconnect/deletion and recovery tested; Nextcloud slot remains stable | Full upgrade migration must flag previously misbound Nextcloud references for explicit repair/reconnect; P4 dispatch freshness beyond credential resolution. |
| LLM API credentials | Stable owner, recoverable reference, transactional configuration/import/rotation/removal; registry rejects replaced selections | Full upgrade migration; P4 dispatch freshness. CLI-owned subscription logins remain a separate open consumer below. |
| SMTP | Recoverable owner-bound references; paired-profile transaction, legacy import, atomic removal and shared-password lifecycle | Full upgrade migration; P4 dispatch freshness. Setup test proves server acceptance, not recipient delivery. |
| Developer services | Owner/service-bound recoverable references; atomic save/import/delete, policy rechecks and stale-reply fencing across HTTP/tools | Full upgrade migration and P4 final dispatch authority. |
| Backup destination / encryption key | Independently owner-bound Vault references, atomic pair migration/configuration, revision-bound tests/upload preparation and replacement-key recovery tested | Full upgrade; outer-envelope import/restore; offline key acknowledgment and historical-key removal semantics. |
| NAS runtime credentials | Supplied Vault projection, isolated browsing, configuration receipt matching | P4/P5 revocable mount/file lifecycle, durable cleanup retry and controller restart acceptance; current helper projection is not yet sufficient for Vault-only completion. |
| Workflow credentials / callback secrets | Recoverable Vault pair, transactional save/import/delete, approval binding and stale discovery checks tested | Full upgrade migration; pending input rewrap/expiry; P4 final dispatch and P9 uncertain-effect recovery. |
| Retired setup OAuth credentials | Archival Vault slots with stable owner; migration 0075, no active client overwrite | Unified upgrade integration and recovery acceptance. |
| Desktop sessions | P1 uses memory-only connection sessions | P5 Vault-issued, revocable projections; no independent persistent credential store. |
| Browser sign-ins | No production implementation; [real synthetic Vault-backed encrypted-image proof](P0_BASELINE.md#vault-controlled-disk-image-proof) passed | P6/P7 real profile/VM integration, consumer stop and verified unmount, crash recovery, local reset and provider logout distinctions. |
| Legacy PC permissions and prepared actions | Installation-key-encrypted policies/requests, no production executor | P4 migration/revalidation into Vault authority; preserve user settings/history without silently activating old grants. |
| Subscription CLI logins | Existing CLI-owned login directories; [source/documentation constraints](P2_CLI_RUNTIME.md) recorded | Implement serialized Vault-owned refresh/write-back and revocable private runtime projections with P4/P5. Claude macOS Keychain needs a verified supported route. No personal login import or implicit exception. |

## Bootstrap and nonsecret verification material

The macOS installer creates protected service material before a database or Vault exists: database access, installation wrapping keys, one-use setup handoff, and voice service tokens. `packaging/macos/lifecycle.py` and `PythonRuntime.py` are part of this audit. Root-of-trust material must remain narrowly protected; ordinary service tokens need a documented Vault-issued projection and rotation/revocation path in the unified lifecycle. Calling every service file “bootstrap” is not an exemption.

Password hashes, one-way session-token hashes, MFA recovery-code hashes and consumed/expiry markers are authentication verification data. They are not plaintext credentials and must retain their replay, account and recovery semantics. Secret values must not be copied into those metadata records. Pending Custom API requests, workflow inputs and task/memory content are a separate encrypted-content classification: inspect their actual payloads and prohibit embedded canonical credentials rather than assume every encrypted blob is either a secret store or harmless metadata.

## Completion conditions

The shared pre-initialization direct-secret write fallback is removed. An explicit administrator/password-confirmed runner migrates 15 database credential families, including inactive connections and retired setup history, with per-record rollback and redacted repair reports. New initialization does not silently import or discard old credentials. Legacy imports need atomic configuration/reference/audit commits, stable ownership, wrong-context rejection, and replacement-key recovery coverage. The runner closes the lazy-reader coverage gap for those stored credentials while the original key is available. Unified upgrade must invoke and inspect it, preserve keys until encrypted-content/projection gates pass, and complete authority reconciliation. A database-format report is not a full recovery certificate.
