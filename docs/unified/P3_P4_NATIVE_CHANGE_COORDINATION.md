# Server coordination for native protected changes

19 October 2026. Implementation checkpoint. The server endpoints are connected; the native client coordinator and first-device enrollment remain to be assembled. No live policy, installation, Vault or device was changed.

`ProtectedChanges` connects fresh administrator verification, exact Vault-derived review, enrolled-device host proofs and final atomic policy mutation. It supports activation/retirement of a Cardinal Rule and replacement of one exact automation permission policy. Each preparation names an existing active device; this route cannot create, revive or trust a new enrollment.

The server derives the device identity from the canonical Vault registry and checks its server UUID against the existing workspace installation UUID. Its origin must match the server's configured public HTTPS or loopback origin. Request JSON, Host headers and renderer labels cannot select a different installation identity. Other existing CE connections remain usable for ordinary chat.

Preparation rebuilds the complete wording/meaning from the exact current Vault records and requires the current super-admin password and enabled MFA for that exact command. The fresh proof remains a transient, non-serializable closure. The coordinator retains at most one pending review per administrator and 64 across this server process. Timers and wall/monotonic checks expire the entry; restart requires fresh verification. Canonical challenge and receipt state remain in the existing encrypted Vault-backed journal.

The HTTP flow under `/admin/automation/protected` exposes preparation, the public hardware challenge, current-state checks, proof-gated presentation delivery, proof-gated wrapped-key projection, commit and cancellation. Every operation requires the same authenticated administrator session that prepared the request. Native host proofs remain necessary even with a valid CE cookie. Response data is private/no-store. Unexpected protected-request errors use a fixed response rather than reaching the general database logger with possible rule or projection content.

Before each stage the coordinator rechecks the fresh proof, current installation, enrolled device, Vault reference and exact regenerated presentation. Commit consumes the account proof and the separate Ed25519 protected-human receipt in the same policy transaction as the canonical version/epoch change. Replaying a host proof cannot approve a policy. A failed or lost commit response must be reconciled against current settings; the in-memory commit capability is discarded, not automatically replayed.

The full encoded protected presentation must fit the native 128 KiB message limit before issuance. Character-count limits alone are insufficient for multi-byte text. Oversized changes are refused without truncated wording.

## Remaining assembly

The catalog now reports whether the server native-review API is supported for its configured origin. The general permanent-change UI flag remains false while the client request/coordinator is unfinished. The ordinary **Make permanent** button is still disabled. First-device enrollment, native request routing, the full permission editor, recovery and release acceptance remain open. This checkpoint supplies no enrollment override, test key, fake human approval or new automation effect permission.

The current coordinator is intentionally bound to one API process. A restart or another process receiving its pending ID refuses the request; it does not reconstruct a fresh password/MFA capability from a database row. Multi-process routing/recovery must preserve that property.

Functional authorization/concurrency, live biometrics, cross-language proof interoperability, failed-response reconciliation and final end-to-end UI acceptance are deferred under the owner's build-first direction.

Build checks passed: complete root TypeScript compilation, public-source secret scan and diff checks. No functional suites or live protected operations were run.
