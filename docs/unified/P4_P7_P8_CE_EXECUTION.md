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
