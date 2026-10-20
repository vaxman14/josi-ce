-- Owner corrections are a separate source, never overwritten by a model's
-- progress checkpoint. No previous model-written notes are relabelled as human.
alter table work_goals add column owner_checkpoint jsonb;
alter table work_goals add column owner_checkpoint_at timestamptz;
alter table work_goals add constraint work_goal_owner_checkpoint_pair check (
  (owner_checkpoint is null and owner_checkpoint_at is null)
  or (owner_checkpoint is not null and jsonb_typeof(owner_checkpoint)='object' and owner_checkpoint_at is not null)
);
-- An opaque version, not a permission or secret. Owner edits invalidate a
-- model context on every surface, including an already-running CLI harness.
alter table users add column work_memory_version integer not null default 1
  check(work_memory_version > 0);
