-- A background segment continues the original request; it never fabricates
-- another inbound user message. Existing native submissions remain unique.
alter table work_goals add column control_generation integer not null default 1 check(control_generation > 0);
alter table work_goals add column continuation_ready_at timestamptz;
alter table work_goals add column continuation_segments integer not null default 0 check(continuation_segments >= 0);
alter table work_goals add column continuation_verified integer not null default 0 check(continuation_verified >= 0);
alter table assistant_turns add column work_goal_id uuid references work_goals(id) on delete cascade;
alter table assistant_turns add column work_goal_revision integer;
alter table assistant_turns add column work_control_generation integer;
alter table assistant_turns add constraint assistant_turn_work_binding check(
  (work_goal_id is null and work_goal_revision is null and work_control_generation is null)
  or (work_goal_id is not null and work_goal_revision > 0 and work_control_generation > 0)
);
alter table assistant_turns drop constraint assistant_turns_inbound_message_id_key;
create unique index assistant_turns_original_inbound on assistant_turns(inbound_message_id) where work_goal_id is null;
create unique index assistant_turns_work_revision on assistant_turns(work_goal_id,work_goal_revision) where work_goal_id is not null;
create unique index assistant_turns_one_active_work on assistant_turns(work_goal_id)
  where work_goal_id is not null and status in ('queued','running');

-- One consequential intent per original goal step. A changed tool or payload
-- cannot mint another attempt; uncertain effects require reconciliation.
create table work_goal_effects (
  goal_id uuid not null references work_goals(id) on delete cascade,
  step_id uuid not null,
  owner_user_id uuid not null references users(id) on delete cascade,
  tool_name text not null,
  input_digest text not null check(input_digest ~ '^[a-f0-9]{64}$'),
  state text not null check(state in ('started','completed')),
  receipt jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key(goal_id,step_id)
);
alter table work_goal_effects enable row level security;
