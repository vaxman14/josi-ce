-- Josi CE 0033: consumer-grade extensibility without exposing plumbing.
--
-- Credentials are always sealed with the installation master key. Exportable
-- configuration deliberately excludes every *_enc column; an imported service
-- returns in a disabled "needs authentication" state.

create table developer_connections (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('github', 'netlify', 'vercel', 'supabase')),
  label text not null,
  base_url text,
  credential_enc text,
  status text not null default 'needs_authentication'
    check (status in ('needs_authentication', 'connected', 'error', 'disabled')),
  last_check_at timestamptz,
  last_check_ok boolean,
  last_error_category text,
  configured_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider)
);
create trigger developer_connections_touch before update on developer_connections
  for each row execute function touch_updated_at();

create table custom_apis (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  base_url text not null,
  auth_type text not null default 'none'
    check (auth_type in ('none', 'api_key', 'bearer', 'basic', 'oauth')),
  credential_enc text,
  enabled boolean not null default false,
  status text not null default 'needs_review'
    check (status in ('needs_review', 'needs_authentication', 'ready', 'error', 'disabled')),
  openapi_source_url text,
  configured_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger custom_apis_touch before update on custom_apis
  for each row execute function touch_updated_at();

create table custom_api_actions (
  id uuid primary key default gen_random_uuid(),
  api_id uuid not null references custom_apis(id) on delete cascade,
  name text not null,
  method text not null check (method in ('GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE')),
  path_template text not null,
  kind text not null check (kind in ('read', 'write', 'delete')),
  enabled boolean not null default false,
  approval_required boolean not null default true,
  created_at timestamptz not null default now(),
  unique (api_id, method, path_template)
);

create table mcp_servers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  transport text not null check (transport in ('https', 'stdio')),
  endpoint text not null,
  credential_enc text,
  enabled boolean not null default false,
  status text not null default 'needs_review'
    check (status in ('needs_review', 'needs_authentication', 'ready', 'error', 'disabled')),
  configured_by uuid references users(id) on delete set null,
  last_check_at timestamptz,
  last_check_ok boolean,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger mcp_servers_touch before update on mcp_servers
  for each row execute function touch_updated_at();

create table mcp_tools (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references mcp_servers(id) on delete cascade,
  tool_name text not null,
  description text,
  kind text not null default 'write' check (kind in ('read', 'write', 'delete')),
  enabled boolean not null default false,
  approval_required boolean not null default true,
  discovered_at timestamptz not null default now(),
  unique (server_id, tool_name)
);

create table installed_skills (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  description text,
  source_type text not null check (source_type in ('curated', 'repository', 'local')),
  source text not null,
  version text,
  publisher text,
  integrity_sha256 text,
  requested_capabilities jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  review_state text not null default 'pending'
    check (review_state in ('pending', 'approved', 'quarantined', 'rejected')),
  installed_by uuid references users(id) on delete set null,
  installed_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger installed_skills_touch before update on installed_skills
  for each row execute function touch_updated_at();

create index custom_api_actions_api on custom_api_actions(api_id);
create index mcp_tools_server on mcp_tools(server_id);

alter table developer_connections enable row level security;
alter table custom_apis enable row level security;
alter table custom_api_actions enable row level security;
alter table mcp_servers enable row level security;
alter table mcp_tools enable row level security;
alter table installed_skills enable row level security;
