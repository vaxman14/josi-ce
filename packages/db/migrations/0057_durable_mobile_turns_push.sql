-- Durable native turns and owner-scoped Expo push delivery.
-- 0056 is intentionally reserved for the assistant migration landing in parallel.

alter table child_activity_minutes drop constraint child_activity_minutes_channel_check;
alter table child_activity_minutes add constraint child_activity_minutes_channel_check
  check(channel in ('web','native','telegram','external'));

create table assistant_turn_capacity (
  owner_user_id uuid primary key references users(id) on delete cascade,
  active_count int not null default 0 check(active_count between 0 and 50)
);

create function reserve_assistant_turn_capacity() returns trigger language plpgsql as $$
begin
  insert into assistant_turn_capacity(owner_user_id,active_count) values(new.owner_user_id,1)
    on conflict(owner_user_id) do update set active_count=assistant_turn_capacity.active_count+1
      where assistant_turn_capacity.active_count<50;
  if not found then raise exception 'assistant_turn_capacity'; end if;
  return new;
end $$;

create function release_assistant_turn_capacity() returns trigger language plpgsql as $$
begin
  if tg_op='DELETE' or (old.status in('queued','running') and new.status in('completed','failed')) then
    update assistant_turn_capacity set active_count=greatest(0,active_count-1) where owner_user_id=old.owner_user_id;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;

create table assistant_turns (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  accepted_session_id uuid not null references sessions(id),
  thread_id uuid not null references threads(id) on delete cascade,
  client_message_id text not null,
  request_hash text not null,
  attempt_of uuid references assistant_turns(id) on delete restrict,
  inbound_message_id uuid not null unique references messages(id) on delete cascade,
  reply_to_message_id uuid references messages(id) on delete set null,
  attachment_ids uuid[] not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  lease_token uuid,
  lease_expires_at timestamptz,
  assistant_message_id uuid unique references messages(id) on delete set null,
  tool_receipts jsonb not null default '[]',
  error_code text,
  error_retryable boolean,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id, thread_id, client_message_id)
);
create index assistant_turns_owner_thread on assistant_turns(owner_user_id,thread_id,created_at desc);
-- A retry is a chain, not a fan-out: only one new attempt may consume a
-- failed predecessor, so duplicate taps with different client ids cannot run
-- the same requested retry twice.
create unique index assistant_turns_one_retry on assistant_turns(attempt_of) where attempt_of is not null;
create index assistant_turns_claim on assistant_turns(status,lease_expires_at,created_at)
  where status in ('queued','running');
create trigger assistant_turns_touch before update on assistant_turns
  for each row execute function touch_updated_at();
create trigger assistant_turns_reserve before insert on assistant_turns
  for each row execute function reserve_assistant_turn_capacity();
create trigger assistant_turns_release after update or delete on assistant_turns
  for each row execute function release_assistant_turn_capacity();

-- One queue row per durable turn. Its payload has only an opaque id.
create unique index job_queue_one_assistant_turn
  on job_queue ((payload->>'turnId')) where kind='assistant.turn';

create table mobile_devices (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  device_identity text not null,
  platform text not null check(platform in ('ios','android')),
  expo_token_enc text not null,
  token_fingerprint text not null,
  app_state text not null default 'background' check(app_state in ('foreground','background','inactive')),
  privacy_locked boolean not null default false,
  categories jsonb not null default '{"assistant":true,"approval":true,"reminder":true,"calendar":true}',
  quiet_start time,
  quiet_end time,
  timezone text not null default 'UTC',
  revoked_at timestamptz,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id,device_identity)
);
create unique index mobile_devices_active_token on mobile_devices(token_fingerprint) where revoked_at is null;
create unique index mobile_devices_active_identity on mobile_devices(device_identity) where revoked_at is null;
create index mobile_devices_owner on mobile_devices(owner_user_id,last_seen_at desc);
create trigger mobile_devices_touch before update on mobile_devices
  for each row execute function touch_updated_at();

create table push_deliveries (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  device_id uuid not null references mobile_devices(id) on delete cascade,
  event_key text not null,
  category text not null check(category in ('assistant','approval','reminder','calendar')),
  route_type text not null check(route_type in ('turn','approval','task','calendar','reminder')),
  route_id uuid not null,
  title text not null,
  body text not null,
  explicit_reminder boolean not null default false,
  status text not null default 'queued' check(status in ('queued','sending','ticketed','checking','delivered','retry','failed','suppressed')),
  lease_token uuid,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  ticket_id text,
  sent_token_fingerprint text,
  receipt_attempts int not null default 0,
  receipt_checked_at timestamptz,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(device_id,event_key)
);
create index push_deliveries_due on push_deliveries(status,next_attempt_at)
  where status in ('queued','retry','sending','ticketed','checking');
create trigger push_deliveries_touch before update on push_deliveries
  for each row execute function touch_updated_at();

alter table assistant_turns enable row level security;
alter table mobile_devices enable row level security;
alter table push_deliveries enable row level security;
