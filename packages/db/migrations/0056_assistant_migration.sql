-- Personal, additive imports. CE's tenant boundary is one installation/database.
-- Raw upload bytes are never persisted. Sanitized, bounded previews are kept
-- only until commit, discard, or expiry.
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

-- Sanitized preview manifests live in PostgreSQL so scan/review/commit work
-- across API replicas without request affinity. They expire quickly and raw
-- uploaded bytes are never stored.
create table migration_previews (
  id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  installation_id uuid not null,
  scanned jsonb,
  reviewed jsonb,
  revision uuid,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  check (scanned is not null),
  check ((reviewed is null) = (revision is null))
);
create index migration_previews_owner on migration_previews (installation_id, owner_user_id, created_at desc);
create index migration_previews_expiry on migration_previews (expires_at);

alter table memories add column migration_batch_id uuid;
alter table memories add column source_provenance jsonb;
alter table memories add column content_fingerprint text;
-- Seed one key for every distinct normalized pre-upgrade fact. Existing exact
-- duplicates remain readable with null keys, but any future create/edit for
-- that normalized content conflicts with the seeded representative.
with ranked as (
  select id,
    md5(lower(regexp_replace(btrim(content), '\s+', ' ', 'g'))) as fingerprint,
    row_number() over (
      partition by owner_user_id, lower(regexp_replace(btrim(content), '\s+', ' ', 'g'))
      order by created_at, id
    ) as position
  from memories
)
update memories m set content_fingerprint = ranked.fingerprint
from ranked where ranked.id = m.id and ranked.position = 1;
alter table memories add constraint memory_migration_owner
  foreign key (migration_batch_id, owner_user_id) references migration_batches(id, owner_user_id);
alter table memories add constraint memory_migration_provenance
  check ((migration_batch_id is null) = (source_provenance is null));
create index memories_migration on memories(migration_batch_id, owner_user_id) where migration_batch_id is not null;
create unique index memories_owner_content_fingerprint
  on memories(owner_user_id, content_fingerprint) where content_fingerprint is not null;

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
alter table migration_previews enable row level security;
alter table migration_archives enable row level security;
