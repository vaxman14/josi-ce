-- App identities are protected Vault records, never a second policy store.
alter table vault_record_heads drop constraint vault_record_heads_kind_check;
alter table vault_record_heads add constraint vault_record_heads_kind_check
  check(kind in ('cardinal_draft','cardinal_review','cardinal_test','cardinal_policy','automation_policy','protected_devices','workspace_storage','automation_targets'));
