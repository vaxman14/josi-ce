-- Login has no authenticated end user yet. Its temporary verifier belongs to
-- the installation's configured OAuth application owner.
alter table auth_oauth_states add column vault_owner_user_id uuid references users(id) on delete cascade;
