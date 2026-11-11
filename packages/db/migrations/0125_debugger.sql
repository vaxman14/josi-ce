-- Josi's built-in debugger (docs/JOSI_DEBUGGER_PLAN.md). Hidden behind a
-- switch. Two small records: what she looked into, and the repairs she
-- proposed. A repair is a row before it is an act, so the person answers in
-- between and every one of them can be read back afterwards.
create table if not exists debug_cases (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  window_minutes integer not null,
  findings jsonb not null default '[]',
  handoff_title text,
  handoff text,
  created_at timestamptz not null default now()
);
create index if not exists debug_cases_thread on debug_cases(owner_user_id, thread_id, created_at desc);
alter table debug_cases enable row level security;

create table if not exists debug_repairs (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  thread_id uuid not null references threads(id) on delete cascade,
  kind text not null check (kind in ('prepare_request_again', 'goal_continue', 'run_reconcile')),
  target_id uuid,
  preview text not null,
  state text not null default 'proposed' check (state in ('proposed', 'done', 'failed')),
  result jsonb,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists debug_repairs_thread on debug_repairs(owner_user_id, thread_id, created_at desc);
alter table debug_repairs enable row level security;
