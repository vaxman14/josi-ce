-- Parental Controls: rules for the whole iPhone, and what the phone reports.
--
-- Same module, same three bounds as 0039 and 0130: a licence, a live
-- `parental_links` row, and nothing else.
--
-- WHAT IS ENFORCED WHERE
--
--   Every `device_*` column below is STORED AND RETURNED. This server enforces
--   none of them. The child's own iPhone does, with Apple's Screen Time, and
--   only if that phone was set up to and allowed to.
--
--   `child_device_events` is what that phone says happened. It is the phone's
--   word: a phone that is off, signed out or tampered with reports nothing.
--   It holds totals and moments, never an app or a website; Apple does not let
--   those leave the phone.

alter table child_controls
  add column if not exists device_daily_limit_minutes integer
    check (device_daily_limit_minutes is null or device_daily_limit_minutes between 5 and 1440),
  -- Minutes past the child's local midnight. May run past midnight, so the
  -- start can be later than the end. Both or neither.
  add column if not exists device_bedtime_start integer
    check (device_bedtime_start is null or device_bedtime_start between 0 and 1439),
  add column if not exists device_bedtime_end integer
    check (device_bedtime_end is null or device_bedtime_end between 0 and 1439),
  add column if not exists device_web_filter boolean not null default false,
  add column if not exists device_max_app_rating integer
    check (device_max_app_rating is null or device_max_app_rating in (4, 9, 12, 17)),
  add column if not exists device_block_app_installs boolean not null default false,
  -- While this is in the future the child's phone lets the counted apps be
  -- changed. Opened by the parent, for ten minutes at a time.
  add column if not exists device_setup_open_until timestamptz;

do $$ begin
  alter table child_controls add constraint child_controls_device_bedtime_pair
    check ((device_bedtime_start is null) = (device_bedtime_end is null)
      and (device_bedtime_start is null or device_bedtime_start <> device_bedtime_end));
exception when duplicate_object then null; end $$;

create table if not exists child_device_events (
  id uuid primary key default gen_random_uuid(),
  child_user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in
    ('phone_minutes', 'limit_reached', 'bedtime_started', 'bedtime_ended', 'asked_more_time')),
  -- For `phone_minutes`: the day's running total. Otherwise usually absent.
  minutes integer check (minutes is null or minutes between 0 and 1440),
  -- When the phone says it happened.
  at timestamptz not null,
  received_at timestamptz not null default now()
);

-- A retry repeats an event exactly; the second copy is the same event.
create unique index if not exists child_device_events_once
  on child_device_events (child_user_id, kind, coalesce(minutes, -1), at);
create index if not exists child_device_events_by_child on child_device_events (child_user_id, at desc);

alter table child_device_events enable row level security;
