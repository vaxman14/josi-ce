-- Protected records share the existing Master Vault key hierarchy. They are
-- deliberately outside generic credential CRUD: deleting a credential cannot
-- delete a rule, review, or enforcement record. No rule is activated here.
alter table vault_state
  add column authority_epoch bigint not null default 1
    check (authority_epoch between 1 and 9007199254740991),
  add column authority_reconciliation_required boolean not null default false;

create table vault_record_heads (
  id uuid primary key,
  kind text not null check (kind in ('cardinal_draft','cardinal_review','cardinal_test')),
  version integer not null check (version > 0),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  updated_at timestamptz not null default now()
);
create table vault_record_versions (
  record_id uuid not null references vault_record_heads(id) on delete restrict,
  version integer not null check (version > 0),
  schema_version integer not null check (schema_version = 1),
  authority_epoch bigint not null check (authority_epoch between 1 and 9007199254740991),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  previous_digest text check (previous_digest ~ '^[a-f0-9]{64}$'),
  value_enc text not null,
  created_by uuid not null references users(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (record_id, version)
);
alter table vault_record_heads enable row level security;
alter table vault_record_versions enable row level security;
