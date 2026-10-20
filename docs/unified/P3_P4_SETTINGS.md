# Cardinal Rules and automation settings

19 October 2026. Administrator UI/API implementation checkpoint. Explicit model advice is connected; permanent activation and execution remain gated.

The server-settings navigation now includes **Automation & Cardinal Rules**. Both HTTP routes and the existing admin route layout require super-admin access; canonical reads/writes also check the live active role inside the Vault transaction.

## Connected behavior

- The rule editor requires explicit actions, all/exact identity scopes, supported denial or original-task-duration restriction, and deny/pause behavior when facts are unavailable. No unselected field silently becomes “all.”
- **Test validity** runs the deterministic supported-rule validator/simulator, displays exact machine meaning and reports cases/issues. It calls no provider and grants no execution authority.
- **Save draft** stores an inactive definition in the existing encrypted Vault. It requires current administrator credentials and MFA when enabled, bound to the exact draft and expected Vault reference. Proof consumption and the Vault write share the transaction. Editing invalidates the earlier test/review. No plaintext draft index or local-storage authority copy is created.
- Draft and active-policy displays decrypt the canonical records for the authorized administrator. Listings are bounded to 100 drafts. Unsupported draft structures are retained and refused by this editor, rather than silently dropping fields.
- **Preview model review** loads the exact current saved draft and primary provider identity, minimizes structured scope IDs, and shows the wording, meaning and guidance that would be sent. It does not transmit them. Saved advisory results remain clearly separate from administrator approval.
- **Send preview and test rule** requires fresh administrator credentials and enabled MFA bound to the exact draft, preview digest and provider configuration. It uses the existing provider registry, Vault credential resolution, local-only/transmission checks, account allowance and usage accounting. No fallback destination is permitted for a preview-bound call. There are no Josi tools, task context, other Vault records or conversation history in this request. The existing provider adapter remains responsible for its isolated transport.
- Dispatch rechecks the current draft, role, session, administrator proof, Vault epoch and selected model. The result is saved to the encrypted draft history with the deterministic report and exact provider identity. A changed draft/model or revoked/expired proof cannot receive a late result. An unusable/unavailable model response is recorded honestly; no automatic retry or favorable review is fabricated. The UI shows all advice, concerns and suggestions and retains no durable local copy.
- The permission view displays the current Vault policy, exact user/server/device/workspace, each action/scope, deny/ask/standing/task/expiry mode and explicit per-task action/byte/duration limits. The API also provides non-authoritative validation for a proposed policy.
- Vault outage, lock, epoch/version conflict, recovery reconciliation and unsupported definitions remain errors. Read responses are private/no-store. Unknown Vault state is shown as unavailable, not an empty policy.

## Remaining connections

The catalog advertises model review support; each preview reports whether the selected chat model and transmission settings permit a request. Permanent changes, enrollment and execution remain unavailable. **Make permanent** is disabled. There is no new HTTP activation, retirement, permission-replacement or secret-export route.

The native display, signed challenge store and permanent-policy mutation engines still need enrolled-device identity, native delivery and Vault runtime-key projection assembled together. The LLM never approves a rule, and a web checkbox cannot substitute for the protected signature on a permanent change.

This checkpoint replaces the earlier implementation assumption that advisory transmission must wait for native enrollment. An explicitly previewed, freshly verified administrator request can ask the configured model for advice, just as the administrator can save an inactive draft. That request does not prove protected local human presence, grant automation access, or make a rule permanent. Native presence remains mandatory for protected policy changes. The review route is not offered as an automation tool.

Permission editing also needs the enrolled device/workspace/application/root catalog and protected replacement flow. Current identity labels/IDs are inspection data, not a browser-supplied grant. General background model continuation and native/browser dispatch remain separate work.

Functional, authorization/concurrency, live-model, native-confirmation and UI acceptance are deferred to the integrated validation phase requested by the owner. This checkpoint has not changed a live Vault or sent any rule to a provider.

Build checks for the initial editor checkpoint: root TypeScript compilation, web type checking and the web production build passed. A compiler file-read stall was resolved by restoring one Undici declaration from the exact lockfile-pinned package after verifying its full package integrity; the old dependency file was retained. No dependency version or source lock changed for that repair.

Advisory integration acceptance remains deferred: exact-content/provider substitution, disconnect and late-response handling, concurrent draft/model changes, permission/cap refusal, real local/hosted/subscription provider behavior and complete UI flows must be exercised after implementation. No live provider was called during this build.

The advisory integration passed the root TypeScript build, web type check, web production bundle and public-source secret scan. Functional suites remain deferred.

The later [native-change coordination checkpoint](P3_P4_NATIVE_CHANGE_COORDINATION.md) connects proof-gated server review/commit, the native client coordinator and activation/retirement controls for already enrolled devices. First-device trust remains open. This supersedes the earlier statements about absent mutation routes and the disabled permanent-change button; it does not enable those actions through an ordinary web approval.
