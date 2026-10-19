-- Migration 0018 retained this retired setup table for manual recovery. Its
-- historical credentials must also survive key replacement, without becoming
-- active OAuth application settings or overwriting the current client.
alter table connector_configs add column vault_owner_user_id uuid references users(id) on delete restrict;
