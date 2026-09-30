-- Twilio is an optional operator-owned channel. Credentials stay in the
-- existing encrypted channel store; call state contains provider identifiers
-- and one-way token hashes only.
alter table external_channel_configs drop constraint if exists external_channel_configs_provider_check;
alter table external_channel_configs add constraint external_channel_configs_provider_check
  check (provider in ('whatsapp', 'slack', 'twilio'));
alter table external_channel_links drop constraint if exists external_channel_links_provider_check;
alter table external_channel_links add constraint external_channel_links_provider_check
  check (provider in ('whatsapp', 'slack', 'twilio'));
alter table external_channel_events drop constraint if exists external_channel_events_provider_check;
alter table external_channel_events add constraint external_channel_events_provider_check
  check (provider in ('whatsapp', 'slack', 'twilio'));
alter table external_channel_outbound drop constraint if exists external_channel_outbound_provider_check;
alter table external_channel_outbound add constraint external_channel_outbound_provider_check
  check (provider in ('whatsapp', 'slack', 'twilio'));
alter table external_channel_link_codes drop constraint if exists external_channel_link_codes_provider_check;
alter table external_channel_link_codes add constraint external_channel_link_codes_provider_check
  check (provider in ('whatsapp', 'slack', 'twilio'));

insert into external_channel_configs (provider) values ('twilio') on conflict do nothing;

create table if not exists twilio_call_sessions (
  call_sid text primary key check (call_sid ~ '^CA[0-9a-fA-F]{32}$'),
  user_id uuid not null references users(id) on delete cascade,
  external_identity text not null,
  direction text not null check (direction in ('inbound', 'outbound')),
  state text not null default 'created'
    check (state in ('created', 'ringing', 'connected', 'completed', 'failed')),
  stream_token_hash text not null check (length(stream_token_hash) = 64),
  stream_sid text,
  thread_id uuid references threads(id) on delete set null,
  created_at timestamptz not null default now(),
  connected_at timestamptz,
  ended_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists twilio_call_sessions_user
  on twilio_call_sessions(user_id, created_at desc);
alter table twilio_call_sessions enable row level security;

create table if not exists twilio_call_intents (
  token_hash text primary key check (length(token_hash) = 64),
  user_id uuid not null references users(id) on delete cascade,
  external_identity text not null,
  thread_id uuid references threads(id) on delete set null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table twilio_call_intents enable row level security;
