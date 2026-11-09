-- Hey Josi: the link to a hosted account, the relay, and paired devices.
--
-- Nothing secret lives here. Private keys and the relay secret are in the OS key
-- store (packages/tunnel/src/keyStore.ts). A device row holds only a public key,
-- and a pairing code only its hash.

-- One row at most. `hosted_url` is null for a server on its own relay, with no
-- account at all.
create table hey_josi_link (
  id boolean primary key default true check (id),
  hosted_url text,
  hosted_public text,
  server_id text,
  site text,
  name text,
  relay_url text,
  plan text not null default 'free' check (plan in ('free', 'connect', 'connect_ai')),
  ai_base_url text,
  usage jsonb,
  relay_enabled boolean not null default false,
  lan_enabled boolean not null default true,
  linked_at timestamptz not null default now(),
  last_sync_at timestamptz,
  last_sync_error text
);

create table relay_devices (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 80),
  platform text not null check (char_length(platform) between 1 and 24),
  public_key text not null unique,
  -- Kept a few minutes after a device changes key, in case the reply was lost.
  previous_public_key text,
  previous_until timestamptz,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references users(id) on delete set null
);
create index relay_devices_owner on relay_devices (owner_user_id);
create index relay_devices_previous on relay_devices (previous_public_key) where previous_public_key is not null;

create table relay_pairing_codes (
  code_hash text primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  device_id uuid references relay_devices(id) on delete set null
);

alter table llm_providers drop constraint if exists llm_providers_provider_check;
alter table llm_providers add constraint llm_providers_provider_check check (
  provider in (
    'openai_compatible',
    'openai', 'anthropic', 'xai',
    'deepseek', 'qwen', 'mistral', 'moonshot', 'zhipu', 'openrouter', 'minimax',
    'gemini', 'cohere', 'bedrock', 'azure_ai', 'vertex_ai', 'ernie', 'hunyuan',
    'hey_josi',
    'openai_subscription', 'anthropic_subscription'
  )
);
