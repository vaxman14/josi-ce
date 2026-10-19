-- Legacy rows acquire their existing super-admin owner when their encrypted
-- credentials are migrated. The credential itself remains in the Master Vault.
alter table telegram_config add column vault_owner_user_id uuid references users(id) on delete restrict;
