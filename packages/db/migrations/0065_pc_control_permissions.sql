-- Additive only: connector/workspace policies and installed data are untouched.
create table pc_control_settings (
  owner_user_id uuid not null references users(id) on delete cascade,
  pc_id text not null,
  enabled boolean not null default false,
  epoch bigint not null default 0,
  primary key(owner_user_id, pc_id)
);
create table pc_control_policies (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  pc_id text not null,
  scope_hash text not null,
  mode text not null check(mode in ('never','ask','task','temporary','always')),
  policy_enc text not null,
  unique(owner_user_id, pc_id, scope_hash),
  foreign key(owner_user_id, pc_id) references pc_control_settings on delete cascade
);
create table pc_control_requests (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  pc_id text not null,
  epoch bigint not null,
  request_hash text not null,
  request_enc text not null,
  human_approved boolean not null default false,
  state text not null check(state in ('pending','approved','denied','executing','succeeded','failed','interrupted','revoked')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key(owner_user_id, pc_id) references pc_control_settings on delete cascade
);
create table pc_control_activity (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null,
  pc_id text not null,
  kind text not null,
  detail_enc text,
  created_at timestamptz not null default now(),
  foreign key(owner_user_id, pc_id) references pc_control_settings on delete cascade
);
create index pc_control_requests_owner on pc_control_requests(owner_user_id, pc_id, created_at desc);
create index pc_control_activity_owner on pc_control_activity(owner_user_id, pc_id, created_at desc);
