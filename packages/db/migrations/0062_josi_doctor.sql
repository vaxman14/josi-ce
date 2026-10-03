-- Browser-first Josi Doctor plans and receipts.
--
-- Diagnostics contain only a fixed vocabulary of subsystem checks. They never
-- contain logs, prompts, messages, credentials, host paths or arbitrary model
-- output. The plan hash binds the separately approved repair to the exact plan
-- the administrator reviewed.
create table doctor_plans (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references users(id) on delete cascade,
  diagnosis_fingerprint text not null check (diagnosis_fingerprint ~ '^[a-f0-9]{64}$'),
  diagnosis jsonb not null default '{}',
  plan jsonb not null default '{}',
  plan_sha256 text not null check (plan_sha256 ~ '^[a-f0-9]{64}$'),
  model_used boolean not null default false,
  model_role text check (model_role in ('primary','fallback')),
  status text not null default 'pending'
    check (status in ('pending','applying','complete','failed','stale')),
  result jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '15 minutes',
  applied_at timestamptz,
  constraint doctor_model_role_consistent check (
    (model_used and model_role is not null) or (not model_used and model_role is null)
  )
);

create index doctor_plans_recent on doctor_plans (created_at desc);
create unique index doctor_one_active_repair on doctor_plans ((true)) where status = 'applying';
alter table doctor_plans enable row level security;
