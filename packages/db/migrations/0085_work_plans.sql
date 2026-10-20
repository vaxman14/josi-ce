-- Existing checklists retain their order. Explicit later plan revisions may
-- identify independent steps; migration never infers independence.
alter table work_goals add column plan_revision integer not null default 1 check(plan_revision > 0);
update work_goals g set steps=(
  select jsonb_agg(step || jsonb_build_object('dependsOn',
    coalesce(step->'dependsOn', case when position=1 then '[]'::jsonb
      else jsonb_build_array(g.steps->(position::integer-2)->>'id') end)) order by position)
  from jsonb_array_elements(g.steps) with ordinality as items(step,position)
);
create table work_goal_plans (
  goal_id uuid not null references work_goals(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  plan_revision integer not null check(plan_revision > 0),
  goal_revision integer not null check(goal_revision > 0),
  steps jsonb not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key(goal_id,plan_revision)
);
alter table work_goal_plans enable row level security;
insert into work_goal_plans(goal_id,owner_user_id,plan_revision,goal_revision,steps,reason,created_at)
select id,owner_user_id,1,revision,steps,'Initial saved plan',created_at from work_goals;
