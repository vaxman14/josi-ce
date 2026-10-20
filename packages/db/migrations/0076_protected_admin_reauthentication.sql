-- One-use verification metadata, like session/recovery-code hashes. Rule
-- contents, credentials and command bodies remain in the Vault, never here.
create table protected_admin_reauth (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_id uuid not null references sessions(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  binding_hash text not null check (binding_hash ~ '^[a-f0-9]{64}$'),
  security_hash text not null check (security_hash ~ '^[a-f0-9]{64}$'),
  authority_epoch bigint not null check (authority_epoch between 1 and 9007199254740991),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '2 minutes',
  used_at timestamptz
);
create index protected_admin_reauth_expiry on protected_admin_reauth(expires_at);
alter table protected_admin_reauth enable row level security;
