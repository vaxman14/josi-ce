# Cardinal Rules and automation settings

19 October 2026. Administrator UI/API implementation checkpoint. Permanent activation, model transmission and execution remain gated.

The server-settings navigation now includes **Automation & Cardinal Rules**. Both HTTP routes and the existing admin route layout require super-admin access; canonical reads/writes also check the live active role inside the Vault transaction.

## Connected behavior

- The rule editor requires explicit actions, all/exact identity scopes, supported denial or original-task-duration restriction, and deny/pause behavior when facts are unavailable. No unselected field silently becomes “all.”
- **Test validity** runs the deterministic supported-rule validator/simulator, displays exact machine meaning and reports cases/issues. It calls no provider and grants no execution authority.
- **Save draft** stores an inactive definition in the existing encrypted Vault. It requires current administrator credentials and MFA when enabled, bound to the exact draft and expected Vault reference. Proof consumption and the Vault write share the transaction. Editing invalidates the earlier test/review. No plaintext draft index or local-storage authority copy is created.
- Draft and active-policy displays decrypt the canonical records for the authorized administrator. Listings are bounded to 100 drafts. Unsupported draft structures are retained and refused by this editor, rather than silently dropping fields.
- **Preview model review** loads the exact current saved draft and primary provider identity, minimizes structured scope IDs, and shows the wording, meaning and guidance that would be sent. It does not transmit them. Saved advisory results remain clearly separate from administrator approval.
- The permission view displays the current Vault policy, exact user/server/device/workspace, each action/scope, deny/ask/standing/task/expiry mode and explicit per-task action/byte/duration limits. The API also provides non-authoritative validation for a proposed policy.
- Vault outage, lock, epoch/version conflict, recovery reconciliation and unsupported definitions remain errors. Read responses are private/no-store. Unknown Vault state is shown as unavailable, not an empty policy.

## Remaining connections

The catalog truthfully advertises model review, permanent changes, enrollment and execution as unavailable. **Make permanent** is disabled. There is no new HTTP activation, retirement, permission-replacement or secret-export route.

The existing model reviewer, protected native display, signed challenge store and exact policy mutation engines still need enrolled-device identity, native delivery and Vault runtime-key projection assembled together. The review disclosure must be approved through that protected boundary before sending rule wording externally. The LLM never approves a rule, and a web checkbox cannot substitute for the protected signature.

Permission editing also needs the enrolled device/workspace/application/root catalog and protected replacement flow. Current identity labels/IDs are inspection data, not a browser-supplied grant. General background model continuation and native/browser dispatch remain separate work.

Functional, authorization/concurrency, live-model, native-confirmation and UI acceptance are deferred to the integrated validation phase requested by the owner. This checkpoint has not changed a live Vault or sent any rule to a provider.

Build checks: root TypeScript compilation, web type checking and the web production build passed. A compiler file-read stall was resolved by restoring one Undici declaration from the exact lockfile-pinned package after verifying its full package integrity; the old dependency file was retained. No dependency version or source lock changed.
