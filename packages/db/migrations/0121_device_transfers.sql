-- "Send to my devices" (docs/WINDOWS_BUILD_LIST.md, added November 9, 2026).
--
-- A person sends a file from one Josi app to another of their own devices,
-- or offers it to another person on this server. The bytes rest here only
-- until the receiving app has them (or the offer is declined or expires),
-- then the content is cleared and the row stays as a short record.

-- The apps a person runs, named by the app itself (the id is the app's own
-- install id, such as the Windows app's x-josi-pc value).
create table transfer_devices (
  user_id uuid not null references users(id) on delete cascade,
  id text not null check (id ~ '^[a-z]{2,8}-[0-9a-f]{8,64}$'),
  name text not null check (length(name) between 1 and 80),
  platform text not null check (platform in ('windows', 'macos', 'android', 'ios', 'web')),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table device_transfers (
  id uuid primary key default gen_random_uuid(),
  sender_user_id uuid not null references users(id) on delete cascade,
  from_device text,
  recipient_user_id uuid not null references users(id) on delete cascade,
  -- Null while an offer to another person waits: the device that accepts
  -- it becomes the one that receives it.
  to_device text,
  name text not null check (length(name) between 1 and 255),
  media_type text not null,
  size bigint not null check (size >= 0),
  content bytea,
  -- offered: waits for the other person to accept. accepted: waits for the
  -- receiving device to fetch it. delivered, declined, expired: finished,
  -- content cleared.
  state text not null check (state in ('offered', 'accepted', 'delivered', 'declined', 'expired')),
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days'
);
create index device_transfers_recipient on device_transfers (recipient_user_id, state);
create index device_transfers_sender on device_transfers (sender_user_id, created_at);
