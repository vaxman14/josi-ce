# Current-work memory and lessons — implementation checkpoint

Build-first implementation; functional, privacy/retention and recovery acceptance remain deferred. No connected model is invoked as part of this build.

## Implemented flow

- Current goals automatically retain checkpoints and supply owner-scoped context on subsequent turns, including after an app/server restart. Context is bounded and the full record remains available through the work tools. Memory mode for long-term learning does not discard an unfinished task's progress.
- The expanded task manager lets the owner correct decisions/reported facts/assumptions/next action, pin or unpin a checkpoint for future conversations, and clear saved notes. Changes require the current goal revision, preserve paused state, and never grant execution permission. At most eight work checkpoints may be pinned per owner.
- Clearing a checkpoint removes its current saved note values. The UI explicitly retains the goal, receipts and original conversation; this is not deletion of all history or backups. Later task activity may save new progress. Clearing also removes its pin.
- The shared known-secret screening from existing memory is now applied to saved goal text. It rejects recognized credential shapes and directs them to the Vault. Pattern matching is not a promise to identify every arbitrary secret; further provider/observation redaction and Vault-reference acceptance remain open.
- The connected assistant can propose a reusable lesson through `propose_work_lesson`. The server resolves the completed, owned source goal and stores its ID/revision with the proposal. It does not accept model-supplied verification receipts. Lessons require owner review even when ordinary fact memory is set to automatic; long-term memory off refuses the proposal.
- Proposed lessons appear in the existing Personalization → Memory review inbox, with a source-work link. The owner can edit the text before keeping it or discard it. Acceptance and creation of the saved memory are transactional. Saved memories support correction, pinning and deletion.
- One proposal per source goal prevents repeated model suggestions. Discarding a work lesson clears its proposal text; deleting an accepted lesson clears the retained proposal text too. The minimal source/decision record remains to prevent automatic reproposal from the same goal. Deleting the source goal cascades its derived proposals/memories.
- Existing memory retrieval supplies approved lessons as context. Neither checkpoints nor memories are consulted as permission/Cardinal Rule authority. No model tool can approve its own work lesson or edit the owner's pinned/corrected checkpoint controls.

## Remaining

Automatic continuation is connected in [P9](P9_CONTINUATION.md). Owner correction provenance and stale-context refusal are connected below. Broader evidence types, learning from reconciled failures, automatic conflict discovery, complete retention/export/recovery reconciliation, and acceptance across all clients remain open. This checkpoint does not claim a completed P10 gate or a universal secret detector.

## Owner corrections and current context

Migration 0087 separates the most recent owner correction from the model's progress checkpoint. Only the owner memory/control routes write that source; ordinary checkpoint saves cannot overwrite it. The record carries its save time. New steering records the owner's next instruction without relabelling existing model facts as human-confirmed. Existing notes are not retrospectively labelled as owner corrections because their authorship cannot be established.

The task manager shows **Your saved correction** and **Latest progress notes** separately. The owner can edit the correction or explicitly review the latest notes as a replacement. Editing captures the displayed goal revision: a background update cannot silently make an old form current. The owner must review a newer version before applying the retained edit. Clearing removes both current note sources and the pin; original conversation, task/effect receipts, audit history and backups remain. Later activity may save fresh progress.

The model receives current saved work again on each server model hop. Complete JSON records are added within a bounded context budget; oversized records are identified as omitted, rather than slicing their text into broken JSON or cutting through a correction. `read_work_goal` supplies the full exact record from the current owned conversation or an explicitly owner-pinned checkpoint. The primary background goal is prioritized. Omission does not imply absence or completion.

Owner corrections, clearing, pin changes and new steering advance an owner-scoped context version in the same transaction. Model dispatch, returned responses and in-process tools check it. The trusted subscription harness also carries the captured version and checks before each user-scoped MCP tool. A stale context must finish and reload; it cannot refresh its own stamp to retain an old prompt. Contextless capability probes remain available. Already-dispatched provider requests/actions cannot be recalled by this check and their truthful receipts are retained.

The storage boundary prevents model replacement of the owner's correction. The prompt instructs Josi to surface conflicting evidence for an owner decision. It does not claim a deterministic detector for every semantic contradiction, a guarantee that a model understands a correction, or deletion of text from a provider request already sent. Full personal-memory/persona invalidation, changes outside these work controls, dispatch races and source deletion/recovery still require integrated coverage.

Build checks: root TypeScript compilation, web type checking and the production bundle. Functional and recovery suites remain deferred under the owner's build-first direction.

## Native memory and lesson review

The native Memory page now connects the existing owner-scoped memory and learning APIs. It supports manual/automatic/off learning preference, explicit memory creation, corrections, pinning, deletion and editing/keeping/discarding proposals. Lessons retain their completed-work provenance and still require owner acceptance. The page explains that memory cannot change Cardinal Rules or permissions and that long-term learning choices do not clear unfinished work or its saved progress.

Edits retain their reviewed original record. Before a mutation, the client rereads the owned collection and refuses a changed/missing record; a changed proposal requires explicit review before keeping a retained edit. Original server ownership and transactional lesson-decision checks remain in force. These client checks do not replace a future atomic revision protocol for every memory edit. Deletion describes the retained source conversation/task/backups.

An owner-facing exact goal lookup allows the source-work sheet to display older completed work beyond the first hundred list results. It uses the same owned-goal resolver and returns no other owner's record. The model's separate thread/pin restriction is unchanged. The native sheet displays criteria, saved steps and source/current revisions and can open the original conversation. It cannot mark a lesson approved or a goal complete.

The root TypeScript build and complete Swift 6 native build passed. A subsequent small UI change retains an unsaved learning-mode selection when another memory action reloads records; final compilation follows in the next package. No live memory, rule, model, goal or account data was accessed or changed. Integrated functional, concurrency, privacy/retention and recovery acceptance remain deferred.
