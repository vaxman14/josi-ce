-- Custom MCP connections: a person's own outside tool servers.
--
-- An MCP server is a web address that offers a list of tools to an assistant.
-- 0044 said CE had none. This adds them, with a different owner from a Custom
-- API on purpose: a Custom API is one installation-wide credential an
-- administrator holds; an MCP connection is ONE PERSON'S, with their own
-- sign-in, and nobody else's conversation can spend it.
--
-- Remote servers only: an https address speaking "Streamable HTTP". Nothing
-- here starts a program on this machine.
--
-- Every statement is idempotent, because one suite applies every migration
-- more than once.

-- Who may add a server at all. One row for the whole installation. The owner
-- (super admin) is always permitted; this decides it for members, exactly as
-- developer_service_policy does per service. Refused until somebody says so.
create table if not exists mcp_policy (
  id boolean primary key default true check (id),
  mode text not null default 'not_allowed'
    check (mode in ('not_allowed', 'everyone', 'specific_users')),
  note text check (note is null or length(note) <= 500),
  updated_at timestamptz not null default now(),
  updated_by uuid references users(id) on delete set null
);
insert into mcp_policy (id) values (true) on conflict (id) do nothing;

-- The named people, when the mode is `specific_users`. Kept when the mode
-- changes, so switching to "everyone" and back does not lose the list.
create table if not exists mcp_allowed_users (
  user_id uuid primary key references users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists mcp_connections (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 80),
  slug text not null check (slug ~ '^[a-z][a-z0-9_]{0,30}[a-z0-9]$'),
  url text not null check (url like 'https://%' and length(url) <= 500),
  host text not null check (length(host) between 1 and 255),
  auth_kind text not null check (auth_kind in ('none', 'bearer', 'header', 'oauth')),
  auth_header text check (auth_header is null or auth_header ~ '^[A-Za-z0-9!#$%&''*+.^_`|~-]{1,64}$'),
  -- A Vault reference, or null when there is nothing to keep. Never a value.
  credentials_enc text,
  -- OAuth facts that are not secret: the endpoints found by discovery, the
  -- client id, the scopes asked for, when the access token runs out.
  oauth jsonb not null default '{}'::jsonb,
  status text not null default 'needs_sign_in'
    check (status in ('active', 'needs_sign_in', 'needs_attention')),
  enabled boolean not null default true,
  last_check_at timestamptz,
  last_check_ok boolean,
  -- A sentence Josi wrote. Never the server's own words.
  last_error text check (last_error is null or length(last_error) <= 300),
  server_name text check (server_name is null or length(server_name) <= 120),
  protocol_version text check (protocol_version is null or length(protocol_version) <= 20),
  -- What the server offered the last time it was asked, already cleaned and
  -- bounded: [{ name, safe, description, inputSchema, readOnly, asks }].
  tools jsonb not null default '[]'::jsonb,
  tools_fetched_at timestamptz,
  tools_dropped int not null default 0,
  -- Tools the person switched off, by the server's own name for them.
  disabled_tools text[] not null default '{}',
  -- Every tool name that has been seen NOT marked read-only since the person
  -- last checked the connection themselves. A server that later relabels one
  -- of these as read-only does not get to skip the question.
  ask_first_names text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists mcp_connections_owner_slug on mcp_connections (owner_user_id, slug);
create index if not exists mcp_connections_owner on mcp_connections (owner_user_id, enabled, created_at);
drop trigger if exists mcp_connections_touch on mcp_connections;
create trigger mcp_connections_touch before update on mcp_connections
  for each row execute function touch_updated_at();

-- One browser sign-in in progress. The key is a hash of the value the browser
-- carries, so a copy of this table is not a set of usable links. Stored and
-- consumed: a second use is a refusal, not a second connection.
create table if not exists mcp_oauth_states (
  state_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  connection_id uuid not null references mcp_connections(id) on delete cascade,
  -- A Vault reference to the PKCE verifier; cleared the moment it is used.
  verifier_enc text,
  redirect_uri text not null,
  native boolean not null default false,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists mcp_oauth_states_expiry on mcp_oauth_states (expires_at);

-- A tool call that is waiting for its owner to say yes. Same shape and the
-- same reasoning as custom_api_pending_calls: sealed arguments, a hash that
-- pins the approval to this exact call, one conditional update that makes
-- "approve" happen once.
create table if not exists mcp_pending_calls (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  connection_id uuid not null references mcp_connections(id) on delete cascade,
  thread_id uuid references threads(id) on delete cascade,
  tool_name text not null check (length(tool_name) between 1 and 128),
  summary text not null check (length(trim(summary)) between 1 and 2000),
  request_enc text not null,
  payload_hash text not null,
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'denied', 'expired', 'executed', 'failed')),
  decided_at timestamptz,
  decided_by uuid references users(id) on delete set null,
  executed_at timestamptz,
  -- What the tool answered, sealed, kept so the conversation that asked can be
  -- told once. Cleared when it has been handed over.
  result_enc text,
  result_delivered_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists mcp_pending_calls_owner
  on mcp_pending_calls (owner_user_id, status, created_at desc);
create unique index if not exists mcp_pending_calls_one_pending
  on mcp_pending_calls (owner_user_id, connection_id, payload_hash)
  where status = 'pending';
drop trigger if exists mcp_pending_calls_touch on mcp_pending_calls;
create trigger mcp_pending_calls_touch before update on mcp_pending_calls
  for each row execute function touch_updated_at();

-- Defence in depth, as on every neighbouring table. CE connects as the owning
-- role, so this does not gate the application; a second, less-privileged role
-- added later starts from deny.
alter table mcp_policy enable row level security;
alter table mcp_allowed_users enable row level security;
alter table mcp_connections enable row level security;
alter table mcp_oauth_states enable row level security;
alter table mcp_pending_calls enable row level security;
