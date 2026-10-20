-- Image passwords and configuration use encrypted, versioned Vault records.
-- This extends the kind constraint only; no plaintext credential table.
alter table vault_record_heads drop constraint vault_record_heads_kind_check;
alter table vault_record_heads add constraint vault_record_heads_kind_check
  check(kind in ('cardinal_draft','cardinal_review','cardinal_test','cardinal_policy','automation_policy','protected_devices','workspace_storage'));
