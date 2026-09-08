-- First-class Restic backup destinations and schedules.
-- Credentials never live in PostgreSQL: secret_ref is an opaque filesystem
-- basename resolved beneath /run/secrets by the backup agent.
create table backup_destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(name) between 1 and 80),
  kind text not null check (kind in ('local', 'nas', 's3', 'r2', 'b2')),
  repository text not null check (length(repository) between 1 and 2048),
  secret_ref text not null check (secret_ref ~ '^[A-Za-z0-9_-]{1,80}$'),
  enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index backup_destinations_name on backup_destinations (lower(name));
create trigger backup_destinations_touch before update on backup_destinations
  for each row execute function touch_updated_at();

create table backup_schedules (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references backup_destinations(id) on delete cascade,
  cadence text not null check (cadence in ('daily', 'weekly')),
  hour_utc smallint not null default 3 check (hour_utc between 0 and 23),
  weekday smallint check (weekday between 0 and 6),
  keep_daily smallint not null default 7 check (keep_daily between 1 and 90),
  keep_weekly smallint not null default 4 check (keep_weekly between 0 and 52),
  keep_monthly smallint not null default 6 check (keep_monthly between 0 and 36),
  enabled boolean not null default true,
  created_by uuid references users(id) on delete set null,
  last_enqueued_at timestamptz,
  next_run_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_needs_weekday check (cadence = 'daily' or weekday is not null)
);
create unique index backup_schedule_per_destination on backup_schedules (destination_id);
create index backup_schedules_due on backup_schedules (next_run_at) where enabled;
create trigger backup_schedules_touch before update on backup_schedules
  for each row execute function touch_updated_at();

create table backup_agent_runs (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references backup_destinations(id) on delete restrict,
  backup_id uuid references backups(id) on delete set null,
  operation text not null check (operation in ('backup', 'check', 'forget', 'restore_test')),
  state text not null check (state in ('running', 'complete', 'failed')),
  snapshot_id text,
  error_category text check (error_category in (
    'repository_unavailable', 'authentication_failed', 'permission_denied',
    'disk_full', 'archive_missing', 'timeout', 'unknown'
  )),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index backup_agent_runs_recent on backup_agent_runs (started_at desc);

alter table backup_destinations enable row level security;
alter table backup_schedules enable row level security;
alter table backup_agent_runs enable row level security;
