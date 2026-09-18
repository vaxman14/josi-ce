-- Personal, additive imports. CE's tenant boundary is one installation/database.
-- No upload bytes or pending previews are persisted.
create table migration_batches (
  id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  installation_id uuid not null,
  manifest_version integer not null check (manifest_version = 1),
  receipt jsonb not null default '{}',
  created_at timestamptz not null default now(),
  rolled_back_at timestamptz,
  unique (id, owner_user_id)
);
create index migration_batches_owner on migration_batches (installation_id, owner_user_id, created_at desc);

alter table memories add column migration_batch_id uuid;
alter table memories add column source_provenance jsonb;
alter table memories add constraint memory_migration_owner
  foreign key (migration_batch_id, owner_user_id) references migration_batches(id, owner_user_id);
alter table memories add constraint memory_migration_provenance
  check ((migration_batch_id is null) = (source_provenance is null));
create index memories_migration on memories(migration_batch_id, owner_user_id) where migration_batch_id is not null;

alter table persona_profiles add column migration_batch_id uuid;
alter table persona_profiles add column source_provenance jsonb;
alter table persona_profiles add constraint profile_migration_owner
  foreign key (migration_batch_id, owner_user_id) references migration_batches(id, owner_user_id);
alter table persona_profiles add constraint profile_migration_provenance
  check ((migration_batch_id is null) = (source_provenance is null)
    and (migration_batch_id is null or kind <> 'agents_admin'));
create index profiles_migration on persona_profiles(migration_batch_id, owner_user_id) where migration_batch_id is not null;

-- Deliberately separate from threads/messages and all prompt/tool retrieval.
create table migration_archives (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references users(id) on delete cascade,
  migration_batch_id uuid not null,
  source_provenance jsonb not null,
  content text not null check (octet_length(content) between 1 and 1048576),
  fingerprint text not null,
  created_at timestamptz not null default now(),
  foreign key (migration_batch_id, owner_user_id) references migration_batches(id, owner_user_id),
  unique (owner_user_id, fingerprint)
);
create index migration_archives_search on migration_archives using gin (to_tsvector('simple', content));
create index migration_archives_owner on migration_archives(owner_user_id, created_at desc, id);

alter table migration_batches enable row level security;
alter table migration_archives enable row level security;
