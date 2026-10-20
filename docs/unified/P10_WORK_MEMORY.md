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

Automatic model continuation, conflict resolution across independently reported facts, broader evidence types, learning from reconciled failures, authoritative correction precedence across long-lived CLI contexts, complete retention/export/recovery reconciliation, and acceptance across all clients remain open. This checkpoint does not claim a completed P10 gate or a universal secret detector.
