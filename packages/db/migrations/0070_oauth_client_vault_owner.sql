-- Attribution may change; canonical OAuth application ownership must not.
alter table oauth_clients add column vault_owner_user_id uuid references users(id) on delete restrict;
