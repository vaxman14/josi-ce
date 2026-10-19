# P2 Vault authority implementation evidence

Date: 19 October 2026. In progress. P0 and P1 checkpoints are on the authorized GitHub branch (`1f40c4f`, `48b5215`). This checkpoint supplies protected storage, not active rules or an automation executor.

## Implemented and checked

Migration 0066 adds versioned protected records and an authority epoch to the existing Master Vault. Rule drafts, meaning reviews, and deterministic-test records are encrypted under the vault’s existing independent master key. Only metadata and ciphertext digests are indexed; there is no plaintext rule preview or second key store. Generic credential deletion cannot affect these records. Writes check the active super-admin row, compare the exact prior reference, preserve old versions, and commit the new version, epoch, and redacted audit together.

Reads re-open the current vault rather than treating an in-memory copy as authority. Ciphertext authentication binds record identity, kind, schema/version, author, prior digest, and epoch. Exact-reference reads reject stale versions/epochs. Lock/unlock changes invalidate references. Recovery retains the existing vault key and both credential and record access, invalidates prior references/UI unlocks, and requires authority reconciliation before further protected writes or exact-reference checks. There is deliberately no shortcut to clear this flag; P3’s verified revalidation flow must supply it before release. Recovery display remains available for inspection.

Credential references now verify the referenced item ID as well as owner/service/slot. A reference to a deleted item cannot silently resolve a newly created credential in the same slot.

Executed checks: 13 core vault/record tests passed; 71 API vault/LLM and registry regression tests passed; `tsc -b packages/core apps/api` passed. Tests cover concurrent edits, live-role changes, master lock, failed audit rollback, ciphertext transplant, uninitialized vault, unsupported kinds, oversized values, missing transactions, replacement-install-key recovery, and credential-reference substitution/deletion. All test databases and keys are synthetic.

## Remaining P2 work

- Migrate all identified canonical credential consumers and eliminate legacy direct-ciphertext writes once their compatibility migrations are verified. Current ordinary credential helpers still retain their preexisting legacy behavior; this checkpoint does not claim vault-only migration is finished.
- Cover Telegram/external channels, mobile push, custom API credentials, OAuth temporary verifier handling, remaining connector/LLM/mail paths, and desktop session projections. Preserve owner and device registration fencing, revocation, and backup/recovery.
- Implement browser encrypted-workspace authority and short-lived execution projections in the dependent runtime phases.
- Add authenticated dispatch freshness and remote-device reconciliation with P3/P4. A reference is a consistency token, not a bearer permission. The record store is an internal API, with no public HTTP/LLM mutation route or activation operation.
- A complete database rollback cannot be detected by a counter stored only in that same database. Paired devices must retain their last acknowledged authority generation and refuse rollback/re-enrollment shortcuts; restore workflows must reconcile before execution. Do not claim this unimplemented integration is proved by storage tests.

The installation key and recovery material remain the bootstrap root of trust. This implementation neither replaces them nor silently imports live user secrets. Tests do not alter an installed server or current user vault.

## Telegram migration checkpoint

Migration 0067 binds Telegram configuration to its Vault owner. New bot/webhook credentials now write only to the Vault; the old columns hold encrypted opaque references. Reads require an initialized, unlocked Vault and migrate legacy ciphertext plus its audit/reference replacement in one transaction. A concurrent rotation invalidates an older configuration snapshot. Local removal clears both canonical slots even while the Vault is locked or remote webhook cleanup fails. API, worker reminder delivery, and public-address restore paths now await Vault resolution.

Executed: the existing Telegram/public-address/channel suites passed 184 tests; five additional migration tests passed (legacy import, locked access, rollback on reference-write failure, rotation/revocation, and no uninitialized fallback). The channel/API/worker TypeScript build passed. Migration uses synthetic credentials only. Old installations without an initialized Vault must complete the existing recovery-key setup before migrated Telegram credentials can be used; upgrade UX for this prerequisite remains P5/P12 work.

## Other chat-channel credentials

Migration 0068 adds the same owner binding to existing external-channel configuration. Slack/WhatsApp credential and webhook pairs now migrate atomically into Vault slots and new writes require the Vault. Async API callers preserve their existing routes. Tests cover lock, paired-write rollback, stale configuration and cross-provider reference substitution, alongside existing navigation/availability checks. The retired Signal route was not re-enabled. The initial migration fixture incorrectly assumed a Signal configuration row; it was narrowed to the two configured providers. Final result: 13 tests passed in two files; channel/API/worker type builds passed.
