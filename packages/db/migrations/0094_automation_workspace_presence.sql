-- Expiring discovery metadata only. This is never a device command, local
-- consent, policy, credential, control lease or proof of completed work.
create table automation_workspace_presence (
  workspace_id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  server_id uuid not null,
  device_id uuid not null,
  storage_session_id uuid not null unique,
  auth_session_id uuid not null references sessions(id) on delete cascade,
  authority_epoch bigint not null check(authority_epoch > 0),
  label text not null check(length(label) between 1 and 120),
  machine_state text not null check(machine_state in ('starting','running','paused','stopped')),
  companion_connected boolean not null default false,
  lease_until timestamptz not null,
  observed_at timestamptz not null default clock_timestamp(),
  closed_at timestamptz,
  check(lease_until <= observed_at + interval '10 seconds')
);
create index automation_workspace_presence_owner on automation_workspace_presence(owner_user_id,observed_at desc);
alter table automation_workspace_presence enable row level security;
