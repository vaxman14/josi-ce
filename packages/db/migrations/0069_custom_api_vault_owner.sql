-- Credential authority remains bound to its Vault owner even if the legacy
-- creator attribution changes. Existing ciphertext is migrated transactionally.
alter table custom_api_connections add column vault_owner_user_id uuid references users(id) on delete restrict;
