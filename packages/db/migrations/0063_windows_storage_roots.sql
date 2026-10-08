-- Native Windows roots are absolute drive paths; API-relative paths retain their
-- existing portable slash form. Keep the independent traversal constraint.
alter table storage_roots drop constraint storage_root_absolute;
alter table storage_roots add constraint storage_root_absolute check (
  container_path like '/%'
  or (
    substring(container_path from 1 for 1) ~ '^[A-Za-z]$'
    and substring(container_path from 2 for 2) in (':/', E':\\')
  )
);
