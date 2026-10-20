-- Temporary participation is canonical encrypted Vault history. It cannot
-- change a permanent policy or revive a lost native session.
alter table vault_record_heads drop constraint vault_record_heads_kind_check;
alter table vault_record_heads add constraint vault_record_heads_kind_check
  check(kind in ('cardinal_draft','cardinal_review','cardinal_test','cardinal_policy','automation_policy','protected_devices','workspace_storage','automation_targets','automation_consent'));
