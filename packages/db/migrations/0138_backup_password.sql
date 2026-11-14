-- The backup password (Docker backups, 2026-11-14).
--
-- A nightly backup has to be sealed without anyone typing a password, so the
-- password is turned into a public key once (see packages/ops/src/archive.ts,
-- envelope 2) and only the public half is kept here: the salt that made it and
-- the key. The server can seal every backup to it and cannot open one again;
-- only the person who knows the password can. The password itself is never stored.
alter table backup_schedule add column if not exists recipient_salt text;
alter table backup_schedule add column if not exists recipient_public text;
alter table backup_schedule add column if not exists password_set_at timestamptz;
