# Server coordination for native protected changes

19 October 2026. Implementation checkpoint. Server endpoints, native client coordination and Cardinal activation/retirement controls are connected in source. First-device enrollment and functional acceptance remain open. No live policy, installation, Vault or device was changed.

`ProtectedChanges` connects fresh administrator verification, exact Vault-derived review, enrolled-device host proofs and final atomic policy mutation. It supports activation/retirement of a Cardinal Rule and replacement of one exact automation permission policy. Each preparation names an existing active device; this route cannot create, revive or trust a new enrollment.

The server derives the device identity from the canonical Vault registry and checks its server UUID against the existing workspace installation UUID. Its origin must match the server's configured public HTTPS or loopback origin. Request JSON, Host headers and renderer labels cannot select a different installation identity. Other existing CE connections remain usable for ordinary chat.

Preparation rebuilds the complete wording/meaning from the exact current Vault records and requires the current super-admin password and enabled MFA for that exact command. The fresh proof remains a transient, non-serializable closure. The coordinator retains at most one pending review per administrator and 64 across this server process. Timers and wall/monotonic checks expire the entry; restart requires fresh verification. Canonical challenge and receipt state remain in the existing encrypted Vault-backed journal.

The HTTP flow under `/admin/automation/protected` exposes preparation, the public hardware challenge, current-state checks, proof-gated presentation delivery, proof-gated wrapped-key projection, commit and cancellation. Every operation requires the same authenticated administrator session that prepared the request. Native host proofs remain necessary even with a valid CE cookie. Response data is private/no-store. Unexpected protected-request errors use a fixed response rather than reaching the general database logger with possible rule or projection content.

Before each stage the coordinator rechecks the fresh proof, current installation, enrolled device, Vault reference and exact regenerated presentation. Commit consumes the account proof and the separate Ed25519 protected-human receipt in the same policy transaction as the canonical version/epoch change. Replaying a host proof cannot approve a policy. A failed or lost commit response must be reconciled against current settings; the in-memory commit capability is discarded, not automatically replayed.

The full encoded protected presentation must fit the native 128 KiB message limit before issuance. Character-count limits alone are insufficient for multi-byte text. Oversized changes are refused without truncated wording.

## Remaining assembly

The catalog reports permanent native-review support for its configured origin. Settings expose **Make permanent** for an unchanged saved/tested draft and **Retire this rule** for an active rule, requiring an enrolled device, the native app and a fresh administrator verification. An ordinary browser or older client cannot supply the native review. First-device enrollment, the full permission editor, recovery and release acceptance remain open. This checkpoint supplies no enrollment override, test key, fake human approval or new automation effect permission.

## Native client coordination

The CE preload exposes only availability and review of a server-prepared challenge ID. The main process accepts that request from its current focused CE window. It chooses the fixed API routes and existing in-memory cookie session, echoes the current CSRF cookie, rejects redirects, bounds response bytes and request duration, and cancels on disconnect, window loss or expiry. The page cannot submit presentation text, keys, a signature, destination URL or an approval boolean to this bridge.

The app obtains the public hardware challenge from that same server, verifies its identity/origin, asks the signed native helper for the narrow P-256 host proof and fetches the protected presentation. The existing broker then shows the complete exact review in its isolated local window. On explicit review acceptance it fetches the one-use wrapped-key projection and requests the separate biometric permanent-change approval. The helper uses that authenticated context for the exact Ed25519 signature. Current server/Vault/administrator state is checked before and after these stages.

The main process sends the final receipt itself and returns only applied/cancelled/unavailable/uncertain status to the CE page. Proofs and wrapped signing material are never returned through page IPC or persisted in client settings. Once commit transmission begins, an unsuccessful or lost response is reported as uncertain and is not retried. The settings page reloads canonical Vault state so the administrator can reconcile the outcome. Closing a review before commit submits no policy change; its pending server review is cancelled when the connection permits or expires normally.

The desktop package and sealed builder now include the existing `@josi-ce/automation` broker alongside the protocol package. The new path requires the signed installed app and real biometric support; it supplies no development authentication fallback. The prepared host proof has a 60-second lifetime, and the fetched key projection has its own 60-second lease within the overall two-minute protected-change/account-proof boundary. A slow review may require a newly prepared request rather than extending old authority.

The current coordinator is intentionally bound to one API process. A restart or another process receiving its pending ID refuses the request; it does not reconstruct a fresh password/MFA capability from a database row. Multi-process routing/recovery must preserve that property.

Functional authorization/concurrency, live biometrics, cross-language proof interoperability, failed-response reconciliation and final end-to-end UI acceptance are deferred under the owner's build-first direction.

Build checks passed: complete root TypeScript compilation, web type checking/production bundle, desktop JavaScript and builder Python syntax, public-source secret scan and diff checks. The dependency/packaging change includes the existing automation broker without changing its version. No functional suites, full app packaging or live protected operations were run.
