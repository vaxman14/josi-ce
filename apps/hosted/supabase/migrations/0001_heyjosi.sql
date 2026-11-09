-- Hey Josi accounts: the schema behind heyjosi.com.
--
-- Everything lives in a private schema, because Supabase's PostgREST serves
-- `public` to anyone holding the project's anon key. RLS is on with no policies
-- as a backstop: if someone ever exposes this schema by mistake, those roles see
-- no rows. The service connects as the table owner, which RLS doesn't apply to.
-- Don't FORCE it, or the service locks itself out.
--
-- Money is integer micro-dollars, so $1 is 1000000 and nothing rounds by accident.
-- Google tokens, codes and verifiers have no column here on purpose: the hosted
-- side passes them through and never keeps them.
create schema if not exists heyjosi;

create table heyjosi.accounts (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  email_verified_at timestamptz,
  password_hash text not null,
  handle text not null unique,
  status text not null default 'active' check (status in ('active', 'suspended')),
  stripe_customer_id text unique,
  created_at timestamptz not null default now()
);

-- A row with `mfa_pending` only lets its holder finish the second step of a login.
create table heyjosi.sessions (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references heyjosi.accounts(id) on delete cascade,
  token_hash text not null unique,
  mfa_pending boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_account on heyjosi.sessions(account_id);
create index sessions_expiry on heyjosi.sessions(expires_at);

-- `secret_sealed` is AES-GCM under ACCOUNT_DATA_KEY. `last_step` stops a code
-- being used twice inside its 30 seconds.
create table heyjosi.totp_secrets (
  account_id uuid primary key references heyjosi.accounts(id) on delete cascade,
  secret_sealed text not null,
  enabled_at timestamptz,
  last_step bigint
);

create table heyjosi.recovery_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references heyjosi.accounts(id) on delete cascade,
  code_hash text not null,
  used_at timestamptz,
  unique (account_id, code_hash)
);

create table heyjosi.email_tokens (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references heyjosi.accounts(id) on delete cascade,
  kind text not null check (kind in ('verify', 'reset', 'household')),
  token_hash text not null unique,
  -- Household invites only: who was asked, and to which household.
  email text,
  household_id uuid,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index email_tokens_expiry on heyjosi.email_tokens(expires_at);

create table heyjosi.link_codes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references heyjosi.accounts(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index link_codes_account on heyjosi.link_codes(account_id);

-- One server per account: the account's name is the server's address.
create table heyjosi.servers (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null unique references heyjosi.accounts(id) on delete cascade,
  noise_public text not null unique,
  noise_previous text,
  previous_until timestamptz,
  site text not null unique,
  name text not null,
  version text,
  lan boolean not null default false,
  ai_token_hash text unique,
  ai_token_issued_at timestamptz,
  linked_at timestamptz not null default now(),
  last_sync_at timestamptz
);
create index servers_previous on heyjosi.servers(noise_previous);

-- A copy of what the server reports, plus what someone asked for on the account
-- page. The server stays the authority on which devices may connect.
create table heyjosi.devices (
  server_id uuid not null references heyjosi.servers(id) on delete cascade,
  device_id text not null,
  name text not null,
  platform text not null,
  paired_at timestamptz,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoke_requested_at timestamptz,
  revoke_delivered_at timestamptz,
  primary key (server_id, device_id)
);

create table heyjosi.subscriptions (
  id text primary key,
  account_id uuid not null references heyjosi.accounts(id) on delete cascade,
  plan text not null check (plan in ('connect', 'connect_ai')),
  status text not null,
  price_id text not null,
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  cancel_at_period_end boolean not null default false,
  updated_at timestamptz not null default now()
);
create index subscriptions_account on heyjosi.subscriptions(account_id);

create table heyjosi.stripe_events (
  id text primary key,
  type text not null,
  processed_at timestamptz not null default now()
);

-- The pool. `topup_micros` is what's left of bought top-ups: it carries across
-- periods, unlike a period's included allowance.
create table heyjosi.households (
  id uuid primary key default gen_random_uuid(),
  owner_account_id uuid not null unique references heyjosi.accounts(id) on delete cascade,
  topup_micros bigint not null default 0 check (topup_micros >= 0),
  created_at timestamptz not null default now()
);

create table heyjosi.household_members (
  household_id uuid not null references heyjosi.households(id) on delete cascade,
  account_id uuid not null unique references heyjosi.accounts(id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  -- This account's own hard limit per period. Null means only the pool limits it.
  cap_micros bigint check (cap_micros >= 0),
  joined_at timestamptz not null default now(),
  primary key (household_id, account_id)
);

-- The checks are the last line of defence for the cap: a bug that tried to spend
-- past the included amount fails its transaction instead of succeeding.
create table heyjosi.allowance_periods (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references heyjosi.households(id) on delete cascade,
  period_start timestamptz not null,
  period_end timestamptz not null,
  included_micros bigint not null check (included_micros >= 0),
  included_spent_micros bigint not null default 0,
  topup_spent_micros bigint not null default 0 check (topup_spent_micros >= 0),
  check (included_spent_micros between 0 and included_micros),
  unique (household_id, period_start)
);

create table heyjosi.models (
  id text primary key,
  label text not null,
  upstream_id text,
  enabled boolean not null default false,
  is_default boolean not null default false,
  multiplier numeric(6, 3) not null default 1 check (multiplier >= 1),
  input_micros_per_million bigint check (input_micros_per_million >= 0),
  output_micros_per_million bigint check (output_micros_per_million >= 0),
  updated_at timestamptz not null default now(),
  check (not enabled or (upstream_id is not null and input_micros_per_million is not null and output_micros_per_million is not null))
);
create unique index models_one_default on heyjosi.models(is_default) where is_default;

insert into heyjosi.models (id, label, upstream_id, enabled, is_default, multiplier, input_micros_per_million, output_micros_per_million) values
  ('gpt-5.6-luna', 'Luna', 'gpt-5.6-luna', true, true, 1, 200000, 1200000),
  ('gpt-5.6-sol', 'Sol', 'gpt-5.6-sol', true, false, 1, 5000000, 30000000),
  ('gpt-5.6-terra', 'Terra', 'gpt-5.6-terra', false, false, 1, 2000000, 12000000),
  -- Named by the product, but no such OpenAI model id is known yet.
  ('astra', 'Astra', null, false, false, 1, null, null);

create table heyjosi.reservations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references heyjosi.households(id) on delete cascade,
  account_id uuid not null references heyjosi.accounts(id) on delete cascade,
  server_id uuid references heyjosi.servers(id) on delete set null,
  model_id text not null references heyjosi.models(id),
  amount_micros bigint not null check (amount_micros > 0),
  state text not null default 'open' check (state in ('open', 'settled')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index reservations_open on heyjosi.reservations(household_id) where state = 'open';
create index reservations_expiry on heyjosi.reservations(expires_at) where state = 'open';

-- Token counts and cost. Never a prompt or a response.
create table heyjosi.usage_rows (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references heyjosi.households(id) on delete cascade,
  period_id uuid references heyjosi.allowance_periods(id) on delete set null,
  account_id uuid not null references heyjosi.accounts(id) on delete cascade,
  server_id uuid references heyjosi.servers(id) on delete set null,
  model_id text not null references heyjosi.models(id),
  input_tokens bigint,
  output_tokens bigint,
  cost_micros bigint not null,
  charged_micros bigint not null,
  outcome text not null check (outcome in ('settled', 'unknown', 'expired', 'released')),
  created_at timestamptz not null default now()
);
create index usage_period_account on heyjosi.usage_rows(period_id, account_id);

create table heyjosi.top_ups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references heyjosi.households(id) on delete cascade,
  account_id uuid references heyjosi.accounts(id) on delete set null,
  amount_micros bigint not null check (amount_micros > 0),
  stripe_session_id text not null unique,
  created_at timestamptz not null default now()
);

-- Survives an account's deletion, with the link to it cut. `detail` holds ids and
-- numbers only.
create table heyjosi.audit_events (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references heyjosi.accounts(id) on delete set null,
  kind text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_account on heyjosi.audit_events(account_id, created_at);

-- Handshakes seen inside the replay window.
create table heyjosi.rpc_nonces (
  nonce text primary key,
  expires_at timestamptz not null
);
create index rpc_nonces_expiry on heyjosi.rpc_nonces(expires_at);

-- Bucket names are keyed hashes, so this table holds no emails or addresses.
create table heyjosi.rate_hits (
  bucket text not null,
  at timestamptz not null
);
create index rate_hits_bucket on heyjosi.rate_hits(bucket, at);

-- Names to take back at the relay. A row stays until the relay has said yes, so
-- an outage can't leave a deleted account's address answering.
create table heyjosi.relay_revocations (
  name text primary key,
  requested_at timestamptz not null default now(),
  attempts integer not null default 0
);

revoke all on schema heyjosi from public;

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'heyjosi' loop
    execute format('alter table heyjosi.%I enable row level security', t.tablename);
  end loop;
  -- These roles only exist on Supabase.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on schema heyjosi from anon;
    revoke all on all tables in schema heyjosi from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke all on schema heyjosi from authenticated;
    revoke all on all tables in schema heyjosi from authenticated;
  end if;
end $$;
