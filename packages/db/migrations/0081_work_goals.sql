-- Owner-scoped work, separate from a reply or an individual provider attempt.
create table work_goals (
  id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  source_message_id uuid not null references messages(id) on delete cascade,
  revision integer not null default 1 check (revision > 0),
  state text not null check (state in ('planning','working','waiting','needs_instruction','paused','verifying','completed','cancelled')),
  outcome text not null,
  criteria jsonb not null,
  steps jsonb not null,
  continuation jsonb,
  activity text not null,
  checkpoint jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  reconciled_at timestamptz not null default now(),
  unique(owner_user_id,source_message_id)
);
create index work_goals_owner on work_goals(owner_user_id,updated_at desc,id);
create index work_goals_thread on work_goals(owner_user_id,thread_id,updated_at desc);
create index work_goals_reconcile on work_goals(state,reconciled_at,id);
create table work_goal_events (
  id uuid primary key,
  goal_id uuid not null references work_goals(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  sequence integer not null,
  kind text not null,
  summary text not null,
  created_at timestamptz not null default now(),
  unique(goal_id,sequence)
);
alter table work_goals enable row level security;
alter table work_goal_events enable row level security;
insert into schedules(kind,payload,interval_seconds,next_run_at,enabled)
select 'work-goals.reconcile','{}'::jsonb,30,now()+interval '30 seconds',true
where not exists(select 1 from schedules where kind='work-goals.reconcile');
