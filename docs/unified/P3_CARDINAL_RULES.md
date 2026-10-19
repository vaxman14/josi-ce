# P3 Cardinal Rules implementation evidence

This is an independent foundation checkpoint, not a completed phase or an enabled automation feature. The P2 protected Vault record store is tested; remaining runtime credential and restore gates stay open. No active rule, permission or installed-server setting is changed by this work.

## Implemented semantics

`cardinalRules.ts` supplies a strict versioned schema, exact explanation, restrictive evaluator and side-effect-free simulator. Each rule requires wording, label, exact action selection, explicit user/server/device/workspace/task selectors, a supported restriction and Deny/Pause behavior for missing facts. IDs are exact; names, patterns, implicit defaults, unknown fields and unsupported restrictions are rejected. Wording is annotation for human/model review; it cannot change executable meaning.

The first supported restrictions are action denial and an inclusive maximum original-task duration in integer seconds. Purchase budgets, recipients, folder containment and other business constraints remain unsupported until their adapters can verify those effects. This checkpoint does not convert a generic UI click into a verified business operation.

The evaluator returns `deny`, `pause` or `no_restriction`. The last result is not permission. Explicit denial wins. An incomplete/unknown effect set cannot prove an action is unaffected. Missing scope or clock facts follow the specified deny/pause behavior; unknown operations and invalid rules pause. Protected authority/Vault administration is always refused through this automation evaluator. P4 must supply authenticated identity, complete effect classification, ordinary grants, original-task time and current device/Vault authority. The pure evaluator does not authenticate a caller's facts.

The simulator exercises matching and unaffected actions, selected actions individually, exact duration boundaries, missing/invalid clock facts, scope mismatches, unknown effects, generic alternate routes, overlapping denial and human-only administration. Results pin the entire wording/structure plus semantics/suite versions and always say execution is disabled. Passing simulations are not live browser/native containment evidence.

## Vault and model review

`CardinalDraftStore` stores each draft and its review/test results in the existing encrypted, versioned protected Vault records. There is no settings copy. Incomplete drafts can be retained but cannot pass validation. Every edit clears review/test results. Writes recheck the live super-admin role, exact Vault reference, lock state, authority epoch and recovery reconciliation. A late model reply cannot attach after an edit, lock/unlock or role loss. Audit failure rolls the version/result back. Ciphertext digests, not low-entropy wording hashes, appear in the ordinary index/audit.

`reviewCardinalMeaning` uses a supplied connected registry provider without tools, task context or a vendor JSON-mode prerequisite. The caller must resolve the currently selected provider with the existing credential, local-only and external-transmission checks. The reviewer receives only the explicit preview: wording, generated structured meaning and rule guidance. Scope IDs are replaced with placeholders. The wording itself cannot reliably be scrubbed of arbitrary secrets; the protected UI must show and authorize the exact preview before sending it. The draft store verifies that preview's digest. No other Vault records or conversation history are sent.

The model returns clarity, explanation, concerns and suggested wording. Extra approval fields, malformed responses and tool requests are rejected. Provider errors are redacted and recorded as unavailable review, without invented advice. Model concern/clarity remains separate from deterministic results: neither a favorable nor an unfavorable opinion changes a rule or activates it. Draft text is never executed as a model instruction or silently replaced with suggestions.

## Remaining P3 acceptance

- Protected editor/preview and Test Rule HTTP integration, with current provider-selection fencing and safe result rendering.
- Authenticated human-only control boundary, fresh super-admin confirmation of the exact tested version, replay-resistant permanent activation, editing active rules and retirement. This checkpoint deliberately exposes no activation method or public mutation route.
- Current active-rule retrieval for dispatch, enforcement-version revalidation, affected-execution pause and verified recovery reconciliation. Restored drafts are inspectable; they do not reactivate authority.
- P4/P5 device/desktop containment that prevents automation from operating protected administration, including alternative routes. A password field alone is not proof of human presence.
- Broader measurable restrictions only as their verifiable adapters become available, plus live executor/bypass acceptance in dependent phases.

Executed: 94 tests passed across the rule semantics, encrypted drafts, existing protected records, model review and subscription-boundary suites. The semantics matrix exercises all supported action names against both restrictions and both missing-fact modes. Core/LLM/API/worker TypeScript builds, whitespace checks and the public-source secret scan passed (1,085 files). One initial assertion compared JSON property order instead of content and was corrected; no production parsing change was needed for it. All fixtures are synthetic; no live model was called and no rule was activated.
