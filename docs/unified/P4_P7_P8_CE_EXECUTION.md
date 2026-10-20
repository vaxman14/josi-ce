# CE browser and computer-control tool integration

19 October 2026. Build-first source checkpoint. The production enrolled-device transport is not installed; this checkpoint does not enable native execution.

## Connected source

The shared agent catalog now includes workspace discovery and receipt inspection, plus `connect_automation_workspace`, `browser_control` and `computer_control`. Action tools are offered only to a durable in-process turn when an installed runtime reports an owned, ready workspace with the corresponding adapter. An ordinary client connection, personal browser profile or model-supplied workspace assertion cannot supply that runtime.

The API and durable worker accept the trusted runtime through their application assembly. The API exposes owner-authenticated, private/no-store workspace discovery. Tasks shows an expandable **Automation desktops** panel with current connection state and available browser/native adapters. It polls only while expanded and visible, reports failed refreshes, and does not turn metadata into a grant or a control button.

`AutomationRuntime` connects server action requests to the existing Vault-backed reservation store. It checks the active owner, original task/conversation, live durable turn/session, current owner-memory version, selected goal step and verified dependencies. Owner-paused, ended or blocked linked work cannot use this path. A read-only inspection is distinguished from a new effect; an unresolved legacy intent blocks further effects.

The enrolled native adapter must classify the actual target and every effect, bind the exact intent digest and current observation, supply current Vault references and a verifiable dispatch proof. Unknown effects refuse. The server reserves policy budgets and records dispatch before invoking the transport once. Observation identity is the durable effect identity: a prior record is returned for reconciliation rather than resent. The original task's outstanding automation dispatch also blocks new non-inspection effects.

Discovery, acquisition and operation transport waits are bounded. Cancellation reaches the adapter; adapters must obey it and recheck local target, consent, current authority and control immediately before input. A timeout cannot undo an already dispatched native operation. Lost replies or failed settlement retain uncertainty. A server-only transition can mark a dispatched record uncertain without inventing success, refunding its budget or completing its durable effect. Final factual evidence still requires the existing native proof verifier.

The action surface accepts opaque observed profile/tab/app/window/element references. Text fill accepts an authorized value reference. It exposes no shell, arbitrary JavaScript, personal profile, raw credential input, settings mutation, policy replacement or model-defined effect list. Known native blockers have fixed safe messages; raw native/provider error bodies are not forwarded.

Returned receipts describe the automation operation only. They do not complete a work goal or prove its business outcome. Screenshots, page text, field values and raw native evidence are not returned by this path; model-visible observation projection still requires separate transmission policy and redaction.

## Required assembly and acceptance

The API/worker entry points do not construct a production runtime yet. First-device enrollment, local consent, authenticated device transport, exact target/effect classification, current Vault projections, native/browser registration, outcome evidence and automation-task creation still need assembly. There is no permissive default adapter. Baseline capability flags continue to report execution unavailable.

Subscription-model processes do not inherit in-process objects. These action tools are therefore not offered on a primary subscription transport until its authenticated runtime bridge is implemented. An unexpected fallback call on that surface refuses as unavailable. Discovery and existing chat/tools remain operational. This is an explicit remaining connection, not a claim of full CLI/native parity.

The shared durable-tool catalog also now records plan revisions as mutations. The plan's compare-and-swap revision already prevented repeated application; the durable turn fence now retains the original tool receipt consistently.

Functional, concurrency, crash/recovery, real device, model-projection and UI acceptance are deferred to the integrated testing pass. No workspace, browser, VM, Vault record or live task was changed while building this checkpoint.

Build checks passed: complete root TypeScript compilation, web type checking, the production web bundle, public-source secret scan (1,175 files) and whitespace checks.

## Initial observation path — 20 October

The shared catalog now has `observe_automation_workspace` for an active task and current control session. The first request needs no invented window, tab or old screen ID. Refreshes name the preceding captured observation, allowing the durable tool fence to distinguish a new inspection from a repeated call.

The runtime routes this through the same original-task checks, Vault budget reservation, dispatch fence, evidence verification and uncertainty handling as existing operations. The adapter must resolve the locally selected canonical app/profile without reading content during preparation, bind the exact session/request and allocate the capture identity. Bootstrap accepts exactly one bounded `computer.observe` application effect or `browser.observe` browser effect. It cannot add launch, input, network or transmission effects.

The local device gate accepts a missing prior observation only for the two explicit inspection verbs. Pointer, element, navigation and other operations still require a matching local observation. Local consent, control generation, authenticated channel, exact command proof, expiry and replay checks still apply to inspection.

This checkpoint returns only the journal receipt and opaque capture reference; it does not return text, labels, elements or screenshots. Authorized content projection to an exact current model configuration, including preventing fallback to an unapproved model, remains to be assembled. No claim of a model seeing the desktop is made. The bootstrap tool is absent unless the installed runtime supplies the inspection adapter; production transport remains unassembled. Full root TypeScript compilation passed; live capture and functional acceptance remain deferred.

## Original automation task attachment — 20 October

`start_automation_task` now attaches one dedicated task to the selected unfinished goal step and the runtime-discovered server/device/workspace. The work record and attachment commit in one transaction after current owner memory, original durable turn/sign-in, plan revision, goal control and dependency checks. Repeating a completed attachment returns the original task; a different workspace, existing action or prior task cannot obtain a replacement attempt. It grants no execution permission.

Migration 0093 adds the internal task template and goal/step binding. The template is excluded from generic task creation. Slot edits and generic state advancement refuse this task type; cancellation/closing remain available, and the legacy worker cannot claim or confirm it. Checkpoint attachment cannot move it to another goal or step.

The runtime now requires that original binding before acquisition, preparation and dispatch, including the exact server/device/workspace, current selected step and current plan. Email or other legacy task IDs cannot stand in for automation tasks. The native saved-task view displays existing automation audit events and an explicit refresh control, with operation success distinguished from business-outcome verification.

The complete TypeScript build, Swift 6 app compilation, whitespace check and public-source secret scan (1,242 files) passed. No migration was applied to a live server, and no task or device operation was executed. Production transport, capture/model projection and factual business-outcome verification remain open. This source is later than `native.11`.

## Native desktop presence — 20 October source checkpoint

The hardware-authenticated workspace opening path now creates expiring discovery metadata. Native lifecycle renewals report machine state and whether the verified guest companion is connected. Renewal cannot create a workspace row, transfer ownership or replace another live storage session. Closure ends the report, and missing renewal expires it after at most ten seconds. Session revocation, a changed Vault authority epoch, account loss and Vault locking also make the report unavailable.

The shared presence reader serves the owner-only assistant endpoint and the actual chat tool execution path, including API/worker/subscription MCP consumers that have no in-process executor. Native and web Task Managers expose the same expiring connection reports. The native disclosure polls only while expanded and active, checks owner/server identity before applying responses and hides state when refresh fails. Old clients may renew without the optional report; that leaves readiness unknown and grants no control.

Migration 0094 stores nonsecret discovery metadata only. Canonical credentials, policy, enrolled device identity and storage remain in the Vault. This reader can never return `ready`, a computer-use adapter or a browser adapter; it does not create an `AutomationRuntime`, enable an action tool, authorize input or verify a business outcome. The UI distinguishes a connected companion from enabled automation. Local consent and real command transport remain the next assembly.

Full root TypeScript compilation, web type checking, Swift 6 native compilation, whitespace checks and the public-source secret scan (1,251 files) passed. No live migration, VM, desktop connection, provider request or functional suite was run. This source is later than `native.12`.

## Protected local desktop consent — 20 October source checkpoint

The native app now presents an exact local participation review and obtains a fresh biometric P-256 proof from the enrolled Mac. Its separate `josi-automation-consent.1` domain binds the server, owner, device, workspace, open storage session, paired guest boot/channel, current permission/Cardinal references and bounded development-session expiry. It cannot sign a permanent rule change or authorize an unpaired desktop. The server consumes a one-use, sixty-second challenge and checks the current hardware key and session again under the Vault transaction.

Migration 0095 adds an encrypted Vault record kind for this temporary approval. It uses the existing Vault key, authenticated history and audit, with no plaintext policy store. Its exact record version changes on approval/revocation; temporary participation does not advance the global permanent-policy epoch and close unrelated workspaces. Generic record writes/reads cannot mutate or export it. Policy, enrollment, recovery and other permanent authority changes retain their existing epoch invalidation.

The native approval requires the currently paired guest. The API's live open-session map and native volatile generation are both required: a saved receipt alone cannot restore control after restart or reconnect. Two-second renewals resolve the current Vault approval, with a ten-second lease; pause, closure, sign-out, connection loss, changed rules or expiry remove local participation. Stop Automation remains callable while other native work is busy and clears local state before the revocation request. Lost approval responses request revocation without replaying the proof. A retained orphaned approval can be cleared with the same Stop control.

This is participation plumbing, not an executing adapter. The guest does not receive commands yet, discovery still refuses `ready`, and responses explicitly keep `executionEnabled: false`. Guest command transport, current target/effect proof, model-visible observation projection and real outcome verification remain open. Root TypeScript, Swift 6 app and protected-helper compilation passed; no live Vault, migration, biometric prompt, VM or functional suite was exercised. This source is newer than `native.12`.

## Guest command receiver — subsequent 20 October source checkpoint

The paired host/guest link now carries a bounded single-command exchange and an exact, separate authorization round trip. The native host accepts commands only through an internal method with a required server authorizer; there is no default permit or renderer route. It checks the current local approval, selected canonical app pin, command expiry, task/session identifiers and replay identity before forwarding. The guest binds the same workspace, boot/channel, consent/permission/Cardinal references, generation and short lease, then invokes `GuestDesktopEngine` only for supported observation, element or pointer operations.

Before any supported read/input, the engine reports only process/app/window geometry metadata, with the title removed. A permit must match that target digest, the exact command bytes, reservation, consent and command expiry. A receipt cannot claim observation or issued input without that permit exchange. The guest retains observations under the engine's existing expiry; the wire returns opaque observation/window IDs only. Text/secret projection, pixel export and model-visible observation export remain refused.

Human takeover, expired consent or connection, pause and Stop terminate guest participation; a reconnect cannot inherit it. The host allows only one pending command, bounds its wait by the command deadline, and remembers consumed reservation IDs. Input reports remain mechanical receipts requiring factual verification; uncertain/lost delivery cannot count as success.

The new host keeps readiness support for older companions and requires the new companion's explicit command protocol before offering local approval. The updated companion is included in the build script; use a matching app/companion pair. Swift 6 host and guest compilation passed with no diagnostics. No VM, real input or functional suite was run.

The CE producer/dispatcher and durable reservation authorization are not yet connected to this internal host method. Discovery and `executionEnabled` therefore remain disabled. The receiver currently binds one original task/control session to its locally approved connection; verified task completion/handoff must be added before moving automatically between tasks. The next assembly must supply current server authorization, durable delivery/outcome handling and authorized content projection before enabling agent tools; this checkpoint does not claim end-to-end automation.

## Durable native inspection assembly — subsequent 20 October source checkpoint

The API and worker now construct the same native inspection runtime. A native heartbeat can publish a short-lived control snapshot only after the existing protected desktop approval, current authenticated storage session, paired guest, foreground registered app and Accessibility readiness. The snapshot is sealed with the existing Vault key and refers to the canonical consent, permission, Cardinal and target records. Migration 0096 adds encrypted transport/control rows; it does not add a credential store or duplicate permanent rules.

An original automation task acquires its current control session. An inspection allocates a new bounded observation identity, reserves the existing permission budget and marks dispatch before queueing. The native app claims a queued item once, validates the exact reserved command bytes and current app pin, then forwards it to the guest. The guest's final metadata request goes back through the API for another task/turn-lease, policy, budget, consent and target check under the original Vault transaction. The native delivery fence is consumed before the permit is returned. Queueing, offering and permitting never reset after a lost response.

The guest receipt returns opaque observation/window IDs, not labels, screenshots or text. Authenticated delivery receipts can settle the original reservation; a missing receipt remains uncertain and is not automatically resent. A denied command after a permit is also conservative uncertainty because a partial inspection may already have read content. Durable reservations now retain the original turn-lease token inside their encrypted plan; older journal rows remain readable but cannot obtain a new native permit.

The adapter advertises **inspection only** and hides/rejects browser/desktop input tools. Native/web status distinguishes that scope. The existing `executionEnabled: false` flags continue to deny input authority; `inspectionAvailable`/the current native control lease describe the narrower path. Model-visible content is still unavailable, and the observation receipt says so explicitly. A fresh local approval can start a new paired connection, but automatic verified handoff between original tasks is not assembled.

Root TypeScript, web type checking, host and companion Swift 6 compilation passed. Public-source secret and whitespace scans passed. No live database migration, VM, screen observation, input, provider request or functional suite was executed. This assembles the inspection flow in source; its actual runtime behavior still requires the deferred functional pass. It is newer than `native.12`, not a new installer.

## Model-visible observation source checkpoint — 20 October 2026

The trusted assistant loop now projects the most recent successful, fresh AX observation into its next provider request. The public tool result and durable transcript remain metadata only. Projection uses a separate `model.transmit` reservation with the exact Vault-registered current primary configuration and the capture's 64 KiB source-content ceiling. It cannot grant computer input or establish completion of the user's outcome.

The original capture delivery is consumed for export once. A `project` guest command binds its original task/session, selected signed app, window/capture, consent/generation, model registry reference and an ephemeral worker X25519 public key. The guest verifies the current server permit and its existing fifteen-second snapshot lifetime, then encrypts that retained snapshot with X25519/HKDF-SHA256/AES-256-GCM. Reservation ID and exact command digest bind the ciphertext. At most 29 ordered 3 KiB base64 chunks travel inside the existing authenticated guest channel; individual wire limits are unchanged. The native app and API receive ciphertext only. The worker private key is never persisted. This is transport key material, not another canonical credential store.

The worker checks capture identity and refuses known credential shapes before using the text. Secure AX fields/descendants remain omitted. This screening cannot identify every possible sensitive value; approving transmission grants the selected model access to the bounded app capture. Only that provider-request copy contains raw captured text. Memory learning, durable tool results, routine logs and original chat history do not automatically retain it. A model's ordinary answer may quote what it saw; this is not a promise that resulting user-visible answers contain no app data. JavaScript references are released after use; no claim of guaranteed RAM erasure is made.

The LLM registry pins the current primary and credential version. For this request it permits one direct HTTP request only, refuses redirects, rechecks configuration/local-only/current task, consent and permission after DNS resolution immediately before fetch, and disables fallback. The final dispatch fence consumes the stored ciphertext; completion/uncertainty writes metadata evidence to the original transmission reservation. A lost receipt cannot reopen delivery or create a retry. OAuth-preflight Vertex/Ernie and subscription CLI transports remain unsupported for this projection; their ordinary chat support is unchanged. Supported direct API adapters still require their current capabilities and explicit matching permission.

Protocol `desktop-command.2` identifies this companion. Version 1 can report connection status but cannot be newly approved by this host for execution. New host and companion source compile with Swift 6, and root/web TypeScript compilation passed. No functional suite, live desktop capture, provider request, installed server, database migration or installer rebuild was run. General input classification, browser service/native registration, selective egress, verified task handoff, remote viewing and integrated acceptance remain open.
