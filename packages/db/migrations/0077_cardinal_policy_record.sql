-- Permanent rule snapshots are encrypted Vault records. The existing generic
-- writer still refuses this kind; only the guarded Cardinal lifecycle writes it.
alter table vault_record_heads drop constraint vault_record_heads_kind_check;
alter table vault_record_heads add constraint vault_record_heads_kind_check
  check (kind in ('cardinal_draft','cardinal_review','cardinal_test','cardinal_policy'));
