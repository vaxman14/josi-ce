-- Ephemeral, encrypted Vault-derived presentations and one-use receipt state.
-- No plaintext rule definitions, private signing keys or independent policy.
create table protected_control_challenges (
  id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  server_id uuid not null,
  device_id uuid not null,
  challenge_enc text not null,
  challenge_mac text not null check (challenge_mac ~ '^[a-f0-9]{64}$'),
  state_mac text not null check (state_mac ~ '^[a-f0-9]{64}$'),
  state text not null default 'pending' check (state in ('pending','consumed','cancelled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index protected_control_challenges_owner on protected_control_challenges(owner_user_id,state,expires_at);
alter table protected_control_challenges enable row level security;
