-- Permissioned desktop workspaces. The server stores capability metadata and
-- short-lived requests; absolute host paths never leave the desktop app.
create table if not exists desktop_workspace_mappings (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  client_id text not null check (length(client_id) between 16 and 200),
  root_id text not null check (length(root_id) between 16 and 200),
  label text not null check (length(label) between 1 and 200),
  writable boolean not null default false,
  status text not null default 'active' check (status in ('active','revoked')),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(owner_user_id, client_id, root_id)
);
create index if not exists desktop_workspace_mappings_owner on desktop_workspace_mappings(owner_user_id, status, last_seen_at desc);
alter table desktop_workspace_mappings enable row level security;

create table if not exists desktop_workspace_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  mapping_id uuid not null references desktop_workspace_mappings(id) on delete cascade,
  operation text not null check (operation in ('list','read','create','edit','mkdir','move','delete')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued','claimed','completed','failed','expired','cancelled')),
  response jsonb,
  error text,
  claimed_at timestamptz,
  completed_at timestamptz,
  expires_at timestamptz not null default now() + interval '45 seconds',
  created_at timestamptz not null default now()
);
create index if not exists desktop_workspace_requests_poll on desktop_workspace_requests(mapping_id, status, created_at);
create index if not exists desktop_workspace_requests_owner on desktop_workspace_requests(owner_user_id, created_at desc);
alter table desktop_workspace_requests enable row level security;
