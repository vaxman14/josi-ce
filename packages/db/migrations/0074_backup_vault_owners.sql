-- Older edits could put the destination and encryption key in different boxes.
-- Resolve each owner from its authenticated pointer before binding it here.
alter table backup_destination add column credentials_owner_user_id uuid references users(id) on delete restrict;
alter table backup_destination add column encryption_owner_user_id uuid references users(id) on delete restrict;
alter table backup_destination add column configuration_revision uuid not null default gen_random_uuid();
