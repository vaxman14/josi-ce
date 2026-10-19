-- Attribution and the current administrator role may change; ownership of
-- existing model credentials must not be inferred anew on each read.
alter table llm_providers add column vault_owner_user_id uuid references users(id) on delete restrict;
