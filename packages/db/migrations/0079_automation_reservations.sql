-- Bookkeeping only, never canonical rules/credentials. A reservation extends
-- the existing durable turn-effect fence instead of creating a retry executor.
create table automation_reservations (
  id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  task_id uuid not null references tasks(id) on delete cascade,
  effect_identity uuid not null,
  proposal_id uuid not null unique,
  turn_effect_id uuid not null unique references assistant_turn_effects(id) on delete cascade,
  plan_enc text not null,
  plan_mac text not null check (plan_mac ~ '^[a-f0-9]{64}$'),
  state_mac text not null check (state_mac ~ '^[a-f0-9]{64}$'),
  authority_epoch bigint not null check (authority_epoch between 1 and 9007199254740991),
  state text not null default 'reserved' check (state in ('reserved','dispatched','succeeded','no_effect','uncertain','cancelled')),
  expires_at timestamptz not null,
  receipt jsonb,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz,
  settled_at timestamptz,
  unique(task_id,effect_identity)
);
create index automation_reservations_owner on automation_reservations(owner_user_id,task_id,state);
alter table automation_reservations enable row level security;
