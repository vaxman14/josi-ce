-- Daily Brief + Memory.
--
-- One short notes file per person, sealed with their own Vault box key (the
-- same sealing My World uses), a small task list with four states, per-person
-- settings, a record of each scheduled run, and the local schedule that looks
-- for runs that are due. No cloud: the worker does all of it.

-- The notes: Goals, Rules, People, Open loops, Task status, Talked through.
-- The text is sealed; only its size and age are visible here.
create table if not exists user_brief_notes (
  user_id uuid primary key references users(id) on delete cascade,
  sealed text not null,
  updated_at timestamptz not null default now()
);

-- Josi proposes "done"; only the person marks it done.
create table if not exists brief_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 300),
  state text not null default 'working' check (state in ('working', 'waiting_on_user', 'blocked', 'done')),
  detail text check (detail is null or length(detail) <= 500),
  done_proposed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists brief_tasks_open on brief_tasks (user_id, state, updated_at desc);

-- Off until the person turns it on: a brief reads their inbox and calendar.
create table if not exists brief_settings (
  user_id uuid primary key references users(id) on delete cascade,
  brief_enabled boolean not null default false,
  checkins_enabled boolean not null default false,
  quiet_start text not null default '22:00' check (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end text not null default '07:00' check (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  timezone text check (timezone is null or length(timezone) between 1 and 60),
  last_brief_day text,
  checkin_day text,
  checkins_today integer not null default 0,
  last_checkin_at timestamptz,
  updated_at timestamptz not null default now()
);

-- One row per scheduled run. A morning brief runs once a local day.
create table if not exists brief_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('morning', 'checkin', 'now')),
  local_day text not null,
  status text not null default 'queued' check (status in ('queued', 'posted', 'silent', 'failed')),
  message_id uuid,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists brief_runs_user on brief_runs (user_id, created_at desc);

-- Looks for due briefs every five minutes. `now() + interval`: see 0021.
insert into schedules (kind, payload, interval_seconds, next_run_at, enabled)
select 'brief.tick', '{}'::jsonb, 300, now() + make_interval(secs => 300), true
where not exists (select 1 from schedules where kind = 'brief.tick');
