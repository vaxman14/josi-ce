alter table external_channel_configs add column vault_owner_user_id uuid references users(id) on delete restrict;
