-- Work bookkeeping, not execution permission. Canonical targets, credentials
-- and policies remain in the Vault. A plan step retains one original task.
insert into task_templates(key,name,contract,requires_capability) values (
  'isolated_automation', 'Separate desktop work',
  '{"slots":{"required":[]},"urgency_ceiling":"push"}'::jsonb,
  'isolated_automation'
);

create table automation_work_tasks (
  task_id uuid primary key references tasks(id) on delete cascade,
  goal_id uuid not null references work_goals(id) on delete cascade,
  step_id uuid not null,
  owner_user_id uuid not null references users(id) on delete cascade,
  server_id uuid not null,
  device_id uuid not null,
  workspace_id uuid not null,
  created_at timestamptz not null default now(),
  unique(goal_id,step_id)
);
create index automation_work_tasks_owner on automation_work_tasks(owner_user_id,workspace_id);
alter table automation_work_tasks enable row level security;
