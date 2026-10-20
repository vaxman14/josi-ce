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

This journal is conservative. It does not infer provider idempotency, reverse effects, reconcile an uncertain destination, or permit a model to rename a step to retry it. Explicit plan revision and destination-specific reconciliation are still required for those cases. Follow-up user turns and newly requested goals retain their existing conversational behavior; general cross-request duplicate detection is not claimed.

## Memory and visibility

Current-work context is appended after personalization assembly, fixing the prior path that accidentally replaced it. Both provider modes now receive the original inbound message ID, so subscription tools can create/checkpoint the same owned work as direct model tools. Automatic segments do not repeatedly learn personal facts from the original request.

Background replies and questions are ordinary saved messages in the original chat. The web chat refreshes canonical recent messages while visible and idle, discards refreshes that overlap a new send, and uses server message IDs rather than duplicating optimistic bubbles. It preserves scroll position when the user is reading earlier messages, labels the bounded recent window, and indicates an offline refresh. The live work cards and Tasks page continue to use their shared owner-scoped event projection. Resume now saves the owner's instructions and schedules continuation.

## Remaining integration and acceptance

The current verifier still covers settled connected-action task receipts and final owner confirmation. Plan revisions/dependencies, independent progress around blocked steps, more precise recovery/backoff, generic artifact/read-only outcome verification, configurable per-goal resource budgets, older-chat pagination, channel delivery and browser/desktop action adapters remain open. Background work currently requires a live owner session. Remote clients keep the existing endpoints and may ignore the additional work projection fields.

No live database migration, model call, provider action or automatic goal was run for this checkpoint. Type/build checks do not establish functional, concurrency, cancellation, crash-recovery, provider-idempotency or migration acceptance; those checks belong to the later integrated pass.

Build checks passed: the complete root TypeScript project build, web TypeScript check and web production bundle. No functional test suite was run.
