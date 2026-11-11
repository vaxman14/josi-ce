-- Parental Controls: two more rules, and a way for a child to ask.
--
-- Everything here lives inside the module that 0039 created and is bound by
-- the same three things: a licence, a live `parental_links` row, and nothing
-- else. No table below is readable by role.
--
-- WHAT IS ENFORCED WHERE, said once here and again in docs/PARENTAL_CONTROLS.md
--
--   blocked_topics   an instruction to the model on the child's own turn. It is
--                    an instruction, not a filter: nothing scans a reply.
--   blocked_apps     stored and returned. THIS SERVER ENFORCES NOTHING about
--                    them; the child's own phone does, with Apple's Family
--                    Controls, and only if that phone has been set up to.
--   extra minutes    extend the daily limit for one local day. They do not
--                    open a closed timetable window.

alter table child_controls
  add column if not exists blocked_topics jsonb not null default '[]'::jsonb
    check (jsonb_typeof(blocked_topics) = 'array' and jsonb_array_length(blocked_topics) <= 20),
  add column if not exists blocked_apps jsonb not null default '[]'::jsonb
    check (jsonb_typeof(blocked_apps) = 'array' and jsonb_array_length(blocked_apps) <= 100);

-- Minutes a parent added to ONE day. Keyed by the child's own local date at
-- the moment of the grant, so tomorrow starts from the standing limit again
-- with no job having to run.
create table if not exists child_extra_minutes (
  child_user_id uuid not null references users(id) on delete cascade,
  day date not null,
  -- A ceiling on the day, not on one grant: a borrowed parent session can add
  -- at most this much, today only, and it is in the trail.
  minutes integer not null check (minutes between 1 and 240),
  updated_at timestamptz not null default now(),
  primary key (child_user_id, day)
);

-- A child asking for more time, or for something to be allowed.
create table if not exists family_requests (
  id uuid primary key default gen_random_uuid(),
  child_user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('more_time', 'access')),
  -- Asked for. Only meaningful for `more_time`.
  minutes integer check (minutes is null or minutes between 5 and 240),
  -- The child's own words to their parent. Shown to the two of them and to
  -- nobody else: never in a notification, never in the audit trail.
  note text check (note is null or length(note) <= 300),
  status text not null default 'open' check (status in ('open', 'approved', 'denied')),
  -- What the parent actually gave, which need not be what was asked.
  minutes_granted integer check (minutes_granted is null or minutes_granted between 1 and 240),
  decided_by_user_id uuid references users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint family_requests_minutes_kind check (kind = 'more_time' or minutes is null)
);

-- One open request per child per kind. A second press of the button is the
-- same question, not a second one.
create unique index if not exists family_requests_one_open
  on family_requests (child_user_id, kind) where status = 'open';
create index if not exists family_requests_by_child on family_requests (child_user_id, created_at desc);

alter table child_extra_minutes enable row level security;
alter table family_requests enable row level security;

-- A push category and a route of its own, so a phone can switch family
-- notifications off without switching off anything else.
alter table push_deliveries drop constraint if exists push_deliveries_category_check;
alter table push_deliveries add constraint push_deliveries_category_check
  check (category in ('assistant', 'approval', 'reminder', 'calendar', 'family'));
alter table push_deliveries drop constraint if exists push_deliveries_route_type_check;
alter table push_deliveries add constraint push_deliveries_route_type_check
  check (route_type in ('turn', 'approval', 'task', 'calendar', 'reminder', 'family'));
