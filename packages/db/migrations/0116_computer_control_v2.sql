-- Separate from the Windows v1 store: no implicit path or policy migration.
create table computer_control_v2 (
  owner_user_id uuid primary key references users(id) on delete cascade,
  state_enc text not null,
  updated_at timestamptz not null default now()
);
