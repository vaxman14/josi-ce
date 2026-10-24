-- Backups redone as one file (build item 42, 2026-10-24).
--
-- A backup row now says whether its file is a sealed envelope (passphrase)
-- and whether the schedule made it rather than a person. The schedule itself
-- is one row: on or off, the hour, how many automatic backups to keep, and an
-- optional folder the newest file is copied into (a drive letter Windows maps
-- to a NAS counts; Josi only writes a file there).
alter table backups add column if not exists encrypted boolean not null default false;
alter table backups add column if not exists automatic boolean not null default false;
alter table backups add column if not exists attachment_count integer not null default 0;

create table if not exists backup_schedule (
  id boolean primary key default true check (id),
  enabled boolean not null default true,
  hour integer not null default 3 check (hour between 0 and 23),
  keep integer not null default 7 check (keep between 1 and 60),
  copy_to text,
  last_run_at timestamptz,
  last_copy_ok boolean,
  last_copy_error text,
  updated_at timestamptz not null default now()
);
insert into backup_schedule (id) values (true) on conflict (id) do nothing;
