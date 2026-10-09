-- Retain the initial recovery key sealed with the existing installation key
-- only until the operator confirms saving it. No existing key is regenerated.
alter table vault_state add column pending_setup_recovery_enc text;
