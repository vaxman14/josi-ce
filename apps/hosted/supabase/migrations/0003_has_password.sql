-- An account made with Google has a random password nobody knows, so it has to be
-- able to create one without proving the old one.
alter table heyjosi.accounts add column has_password boolean not null default true;
update heyjosi.accounts a set has_password = false
  where exists (select 1 from heyjosi.audit_events e where e.account_id = a.id and e.kind = 'account.created_google');
