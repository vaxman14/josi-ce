-- Owner steering preserves original step/effect identities. A changed outcome
-- requires a plan bound to the new version before further assistant effects.
alter table work_goals add column outcome_revision integer not null default 1 check(outcome_revision > 0);
alter table work_goals add column planned_outcome_revision integer not null default 1;
alter table work_goals add constraint work_goal_planned_outcome check
  (planned_outcome_revision > 0 and planned_outcome_revision <= outcome_revision);
alter table work_goal_plans add column outcome_revision integer not null default 1 check(outcome_revision > 0);
create table work_goal_outcomes (
  goal_id uuid not null references work_goals(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  outcome_revision integer not null check(outcome_revision > 0),
  goal_revision integer not null check(goal_revision > 0),
  outcome text not null,
  criteria jsonb not null,
  reason text not null,
  source text not null check(source in ('existing_record','request_plan','owner_edit')),
  created_at timestamptz not null default now(),
  primary key(goal_id,outcome_revision)
);
alter table work_goal_outcomes enable row level security;
insert into work_goal_outcomes(goal_id,owner_user_id,outcome_revision,goal_revision,outcome,criteria,reason,source,created_at)
select id,owner_user_id,1,revision,outcome,criteria,'Outcome retained from existing work','existing_record',created_at from work_goals;
