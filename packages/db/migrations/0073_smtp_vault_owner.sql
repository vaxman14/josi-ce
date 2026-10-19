alter table smtp_profiles add column vault_owner_user_id uuid references users(id) on delete restrict;
