# P2 credential migration inventory

Source audit updated 19 October 2026. This is a work ledger, not a claim that Vault-only authority is complete. See [P2 evidence](P2_VAULT.md) for executed checks. No live user credentials were read during this inventory.

| Consumer | Canonical target / current checkpoint | Remaining work |
|---|---|---|
| Cardinal Rules | Existing Vault protected records; draft/review/test versions | P3 activation, fresh administrator authentication, revalidation and recovery reconciliation. |
| Telegram, Slack, WhatsApp | Owner-bound recoverable Vault references, transactional legacy import | Upgrade-wide migration before replacing an installation key. |
| Mobile push | Vault item per owner/device identity; registration and receipt fencing | End-to-end remote-client acceptance in P12. |
| Custom API | Vault item per connection; transactional import/rotation/deletion | P4 dispatch authority; full upgrade migration. |
| OAuth application credentials | Vault item per provider, stable owner; transactional migration and consumer regressions passed | Full upgrade migration. |
| Account-connection PKCE | Temporary Vault item per hashed state; transactional consumption, worker expiration cleanup and callback regressions passed | P12 upgrade/end-to-end acceptance. |
| Google web/native Josi login PKCE | Owner-bound temporary Vault references; one-use, recovery, native-return, lock and expiration tests passed | P12 upgrade/end-to-end acceptance. |
| MFA/TOTP | Recoverable Vault reference; transactional setup/enable/disable and ordinary MFA login, shared factor reader for Apple/parental authority | Full upgrade migration; P12 end-to-end recovery and reauthentication acceptance. Recovery-code hashes remain usable while locked; enabled MFA is never skipped because its key/secret is unavailable. |
| OAuth account tokens / Nextcloud | Strict Vault writes, transactional import/rotation/refresh/reconnect/deletion and recovery tested; Nextcloud slot remains stable | Full upgrade migration must flag previously misbound Nextcloud references for explicit repair/reconnect; P4 dispatch freshness beyond credential resolution. |
| LLM API credentials | New references supported, older payloads still directly opened | Stable ownership, legacy migration, atomic configuration/rotation and removal. |
| SMTP | New setup writes reference Vault; legacy reader remains | Stable owner, legacy import, atomic setup/update and removal. |
| Developer services | Existing Vault helper references | Transactional legacy migration, stable owner, all tool/read paths and deletion. |
| Backup destination / encryption key | Existing Vault helper references | Transactional migration, backup/restore bootstrapping and rotation; avoid circular recovery dependencies. |
| Workflow credentials / callback secrets | Existing Vault helpers, sealed pending inputs | Transactional legacy migration and paired-secret rotation; classify input payloads separately. |
| Desktop sessions | P1 uses memory-only connection sessions | P5 Vault-issued, revocable projections; no independent persistent credential store. |
| Browser sign-ins | No production implementation | P6/P7 Vault-controlled encrypted workspace lifecycle, crash recovery, local reset and provider logout distinctions. |
| Subscription CLI logins | Existing CLI-owned login directories | Inventory and govern application-managed runtime projections; do not import personal login directories or treat external CLI storage as an implicit exception. |

## Bootstrap and nonsecret verification material

The macOS installer creates protected service material before a database or Vault exists: database access, installation wrapping keys, one-use setup handoff, and voice service tokens. `packaging/macos/lifecycle.py` and `PythonRuntime.py` are part of this audit. Root-of-trust material must remain narrowly protected; ordinary service tokens need a documented Vault-issued projection and rotation/revocation path in the unified lifecycle. Calling every service file “bootstrap” is not an exemption.

Password hashes, one-way session-token hashes, MFA recovery-code hashes and consumed/expiry markers are authentication verification data. They are not plaintext credentials and must retain their replay, account and recovery semantics. Secret values must not be copied into those metadata records. Pending Custom API requests, workflow inputs and task/memory content are a separate encrypted-content classification: inspect their actual payloads and prohibit embedded canonical credentials rather than assume every encrypted blob is either a secret store or harmless metadata.

## Completion conditions

Remove the shared pre-initialization direct-secret fallback only after all callers have explicit Vault prerequisites and tested upgrades. New initialization must not silently discard old credentials. Legacy imports need atomic configuration/reference/audit commits, stable ownership, wrong-context rejection, and replacement-key recovery coverage. A lazy reader alone cannot preserve unused install-key ciphertext after the old key is lost: the upgrade/recovery workflow needs a complete migration inventory and reconciliation before declaring success.
