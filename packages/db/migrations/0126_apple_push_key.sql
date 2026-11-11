-- iPhone push goes straight to Apple. The server signs each request with an
-- Apple push key (.p8). The key itself is sealed in the Vault under the admin
-- who pasted it; only its two public ids sit here, so a screen can say which
-- key is in use without opening anything.
create table if not exists server_push_keys (
  provider text primary key check (provider in ('apple')),
  owner_user_id uuid not null references users(id) on delete cascade,
  key_id text not null,
  team_id text not null,
  credential_enc text not null,
  checked text not null default 'unknown' check (checked in ('accepted', 'unknown')),
  updated_at timestamptz not null default now()
);
alter table server_push_keys enable row level security;
