-- Passkeys and email sign-in codes, plus the skin a person chose.
--
-- A passkey row holds a public key only. A challenge and an email code are
-- stored as hashes, so a dump of these tables signs nobody in. An email address
-- is stored as a hash too, because this table also records addresses that match
-- no account, and it has no business keeping those.

create table auth_passkeys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  credential_id text not null unique,
  public_key text not null,
  algorithm integer not null,
  sign_count bigint not null default 0,
  transports text[] not null default '{}',
  name text not null check (char_length(name) between 1 and 80),
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index auth_passkeys_user on auth_passkeys (user_id);
alter table auth_passkeys enable row level security;

create table auth_passkey_challenges (
  challenge_hash text primary key,
  purpose text not null check (purpose in ('register', 'login')),
  user_id uuid references users(id) on delete cascade,
  ip text,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_passkey_challenges_ip on auth_passkey_challenges (ip, created_at);
alter table auth_passkey_challenges enable row level security;

-- `user_id` and `code_hash` are null when the address matched no account. The
-- row still exists so the rate limits behave the same either way.
create table auth_email_codes (
  id uuid primary key default gen_random_uuid(),
  email_hash text not null,
  user_id uuid references users(id) on delete cascade,
  code_hash text,
  ip text,
  attempts integer not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index auth_email_codes_email on auth_email_codes (email_hash, created_at desc);
create index auth_email_codes_ip on auth_email_codes (ip, created_at);
alter table auth_email_codes enable row level security;

alter table persona_settings add column skin text check (skin in ('plum-gold', 'classic-navy'));
