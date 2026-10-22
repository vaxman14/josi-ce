-- Settings changes proposed in conversation. Josi prepares the exact change;
-- a person makes it live from the app. Additive only.
create table settings_change_proposals (
  id uuid primary key default gen_random_uuid(),
  proposer_user_id uuid not null references users(id) on delete cascade,
  -- 'personal' changes the proposer's own settings; 'administrator' changes
  -- the installation and needs the super-admin.
  scope text not null check (scope in ('personal', 'administrator')),
  area text not null,
  sensitive boolean not null default false,
  title text not null check (length(title) between 1 and 200),
  summary text not null check (length(summary) between 1 and 2000),
  -- The exact request the app performs with the approver's own session, so
  -- every route's own checks (role, password step-up) still run.
  method text not null check (method in ('PUT', 'PATCH', 'POST', 'DELETE')),
  path text not null check (length(path) between 1 and 500),
  body jsonb not null default '{}',
  state text not null default 'proposed'
    check (state in ('proposed', 'approved', 'applied', 'failed', 'denied', 'expired')),
  approved_by uuid references users(id) on delete set null,
  approved_at timestamptz,
  applied_by uuid references users(id) on delete set null,
  applied_at timestamptz,
  error text,
  notified_at timestamptz,
  expires_at timestamptz not null default now() + interval '24 hours',
  created_at timestamptz not null default now()
);
create index settings_change_proposals_proposer on settings_change_proposals (proposer_user_id, state, created_at desc);
create index settings_change_proposals_state on settings_change_proposals (state, created_at desc);
