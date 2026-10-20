# Owned-work continuation

19 October 2026. Integrated source checkpoint. Functional and recovery acceptance are deferred under the owner's build-first direction.

## Connected behavior

The existing reconciliation worker can now queue another durable assistant segment for a saved action or a due wait. Migration 0083 links the segment to the original goal, revision and control generation. It reuses the real original inbound message and its available attachment receipts instead of inserting a fake user instruction. The ordinary native-message uniqueness constraint remains in place for user submissions. Queue payloads contain only the turn ID.

The first model segment still starts from an authenticated user request. When its conversation turn ends, eligible goals become ready after 30 seconds. The worker checks existing task results before continuing. Each automatic segment uses the existing provider registry, capability selection, spending caps, child-account limits, tool permissions and durable worker lease. It requires an active owner, open conversation and live owner session. The background step-up context is its own goal context; it does not inherit a person's elevated session approval.

The model sees the original request labelled as original context, the current saved goal and recent conversation. Relative dates for actions stay anchored to the original request's time. The model must save a meaningful checkpoint and concrete next action, wait or question. A completed reply with no changed work record asks for instructions instead of continuing forever. A failed or interrupted segment is not exposed as a generic retry of a new user request.

Each goal has a visible limit of twelve automatic segments without a newly verified step. A verified step or explicit owner Resume resets that counter. Model/provider limits still apply independently. Exhaustion records a specific question and leaves the goal unfinished. This is an implementation bound, not the finished configurable action/cost/schedule budget editor.

Pause, cancel, owner steering, work-note correction and a new foreground conversation turn invalidate the prior control generation. Every automatic model hop and tool call checks current control, session, owner, thread and lease. A new inbound user message also supersedes an in-flight automatic segment. Queued old segments are cancelled. A saved question/wait ends the segment with that status. Already-dispatched legacy provider effects may finish and retain their truthful receipts; this is not the future native emergency stop.

## Original-step effect identity

The shared in-process executor and subscription MCP adapter use the same original-goal/step intent journal for task creation, action drafts, custom API calls, native workflows, workspace proposals and reminder scheduling. It stores a digest of the exact tool/input and the resulting receipt, under owner scope. Each step has one such consequential intent. Repeating the exact completed intent returns its receipt. Changing its tool/input or encountering an unsettled intent refuses a new dispatch; process restarts and new model segments do not create a fresh effect identity.

The ordinary per-turn fence remains underneath this journal. Other automatic mutations without an explicit adapter are refused. An automatic segment cannot create a replacement goal, approve/cancel a pending task, edit a reminder, change collecting task slots, or propose a memory lesson. It may read, checkpoint and verify its assigned goal and use supported tools within their existing authorization. Unsupported tool calls are refused even when their names occur elsewhere in the global catalog.

This journal is conservative. It does not infer provider idempotency, reverse effects, reconcile an uncertain destination, or permit a model to rename a step to retry it. Destination-specific receipt reconciliation is still required for those cases. Follow-up user turns and newly requested goals retain their existing conversational behavior; general cross-request duplicate detection is not claimed.

## Plan changes and independent progress

Migration 0085 adds retained plan versions and explicit step dependencies. Existing and new plain checklists start sequentially; no migration guesses that actions are independent. `revise_goal_plan` can reorder steps, add needed steps and explicitly describe independence, while retaining every original step ID. The server rejects cycles, missing/duplicate dependencies, removal of an old step, and changes to the meaning or dependencies of any step with a task/effect/verified receipt. Outcome criteria remain unchanged. A plan revision cannot erase a blocker, detach its task or supply a fresh action identity. The existing goal revision guards concurrent changes, and pause still requires owner resumption.

Checkpointing and effect dispatch require verified dependencies. The effect journal also refuses the same exact tool/input under another step of the same goal. That is a concrete duplicate check, not a claim to recognize every semantically equivalent request. A model cannot overwrite an existing task link with another task to obtain another attempt.

A step can retain a precise blocker or scheduled check while independent steps continue. A question tied to one step is saved in chat while the returned goal can remain working on an eligible independent step. The reconciliation worker skips active/blocked steps and chooses ready work; when no ready work remains, it retains the earliest timed wait or asks for the unresolved instruction. Timed checks do not reset effect receipts or permit repeating an uncertain action.

An unsettled effect can now receive a bounded inspection segment. Existing read tools and goal bookkeeping remain available; dispatch of any new consequential effect is refused until the original receipt is reconciled. Model prose cannot settle that receipt. The existing no-progress segment limit applies, so unsupported destination reconciliation returns for instructions.

The larger task manager displays dependencies, exact blockers, scheduled rechecks and paginated plan history, including why each version changed. Chat cards show the same step states. History is owner-scoped work data, not a second memory/rule authority.

## Owner changes to the requested outcome

Migration 0088 retains versions of the requested outcome and completion criteria, separately from plan versions. The task manager's **Change requested outcome** form requires an explicit explanation and a choice to continue or remain paused. The saved goal revision prevents a stale form overwriting newer work; the form retains the edit and requires a deliberate review before rebasing it. Existing records are labelled as retained history, not retroactively attributed to an explicit owner edit. Ended goals cannot be rewritten.

Saving invalidates queued automatic segments and current work-memory projections, retains every original step, task, verified receipt and action-budget record, and records the change in the original conversation. It does not undo an operation already handed to an executor/provider. A new outcome version makes the old plan unreviewed. The continuation worker can schedule a planning segment even when all previous steps already have receipts; it cannot automatically confirm the new outcome from those receipts.

`revise_goal_plan` must name the exact current outcome version and retain the original step/effect identities. Only that transaction binds the plan to the changed outcome. Until then, the shared in-process/subscription tool wrapper holds new mutations in the conversation (except plan revision and a question checkpoint); the native automation runtime also checks before consequential dispatch. Read-only inspection remains available where its existing adapter permits it. Legacy tools without an unambiguous goal binding are held conservatively for the conversation, rather than guessed to belong to different work.

This is an explicit version binding, not proof that a model's proposed plan semantically covers every criterion. Existing dependency, receipt and owner outcome-confirmation checks remain. The plan cannot retire an obsolete original step yet; the UI explains that replacing the work entirely requires cancelling and starting a new goal. This checkpoint changes no direct human approval route, resumes no old provider effect, and adds no permission. Retirement of obsolete steps with their durable effect history still needs its own owner flow.

Outcome history is owner scoped, private/no-store and paginated. Plan history shows which outcome version it addresses. Older clients can ignore the additional fields; the new editor is hidden when an older server does not advertise an outcome revision.

## Memory and visibility

Current-work context is appended after personalization assembly, fixing the prior path that accidentally replaced it. Both provider modes now receive the original inbound message ID, so subscription tools can create/checkpoint the same owned work as direct model tools. Automatic segments do not repeatedly learn personal facts from the original request.

Background replies and questions are ordinary saved messages in the original chat. The web chat refreshes canonical recent messages while visible and idle, discards refreshes that overlap a new send, and uses server message IDs rather than duplicating optimistic bubbles. It preserves scroll position when the user is reading earlier messages, labels the bounded recent window, and indicates an offline refresh. The live work cards and Tasks page continue to use their shared owner-scoped event projection. Resume now saves the owner's instructions and schedules continuation.

## Remaining integration and acceptance

The current verifier still covers settled connected-action task receipts and final owner confirmation. Removing/replacing an obsolete step needs a further explicit owner flow; the model cannot silently erase it. More precise destination reconciliation/backoff, generic artifact/read-only outcome verification, configurable per-goal resource budgets, older-chat pagination and production browser/desktop adapters remain open. Telegram checklist delivery is connected in the separate P11 checkpoint. Background work currently requires a live owner session. Remote clients keep the existing endpoints and may ignore the additional work projection fields.

No live database migration, model call, provider action or automatic goal was run for this checkpoint. Type/build checks do not establish functional, concurrency, cancellation, crash-recovery, provider-idempotency or migration acceptance; those checks belong to the later integrated pass.

Build checks passed: the complete root TypeScript project build, web TypeScript check and web production bundle. No functional test suite was run.
