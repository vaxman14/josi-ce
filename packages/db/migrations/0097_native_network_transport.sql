-- Short-lived consume-once network stages. Canonical permissions and secrets
-- remain in the Vault; these records use its existing encrypted projections.
create table automation_native_networks (
  reservation_id uuid primary key references automation_reservations(id) on delete restrict,
  request_id uuid not null unique,
  owner_user_id uuid not null references users(id) on delete cascade,
  storage_session_id uuid not null references automation_native_controls(storage_session_id) on delete restrict,
  expires_at timestamptz not null,
  value_enc text not null
);
create index automation_native_networks_session on automation_native_networks(storage_session_id,expires_at);
alter table automation_native_networks enable row level security;
