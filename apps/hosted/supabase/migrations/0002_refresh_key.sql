-- A server's second key, good for google.refresh only. See its background worker.
alter table heyjosi.servers add column refresh_public text unique;
