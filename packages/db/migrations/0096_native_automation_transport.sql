-- Short-lived transport/control state, encrypted and authenticated with the
-- existing Vault key. Permanent authority remains in canonical Vault records.
create table automation_native_controls (
  storage_session_id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  workspace_id uuid not null,
  value_enc text not null,
  updated_at timestamptz not null default clock_timestamp()
);
create index automation_native_controls_owner on automation_native_controls(owner_user_id,workspace_id);
alter table automation_native_controls enable row level security;

create table automation_native_deliveries (
  reservation_id uuid primary key references automation_reservations(id) on delete restrict,
  owner_user_id uuid not null references users(id) on delete cascade,
  storage_session_id uuid not null references automation_native_controls(storage_session_id) on delete restrict,
  state text not null check(state in ('queued','offered','permitted','finished')),
  expires_at timestamptz not null,
  value_enc text not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create index automation_native_deliveries_pending on automation_native_deliveries(storage_session_id,state,expires_at);
alter table automation_native_deliveries enable row level security;
