-- Ordinary owner instructions, not Vault rules or tool authority. Preserve
-- existing behavior until an owner explicitly sets a goal-specific limit.
alter table work_goals
  add column automatic_run_limit integer check(automatic_run_limit between 0 and 10000),
  add column automatic_runs_used integer not null default 0 check(automatic_runs_used >= 0),
  add column automatic_deadline timestamptz;
update work_goals g set automatic_runs_used=(
  select count(*)::integer from assistant_turns t where t.work_goal_id=g.id
);
