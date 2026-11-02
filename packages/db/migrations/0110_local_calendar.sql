-- A calendar kept on this server, with no Google or Microsoft account behind
-- it. It is a connection like the others (so calendar sources, sync origins
-- and the capability switches keep one shape), with provider 'local': the
-- events live in calendar_events and nothing is pushed anywhere.
alter table connections drop constraint if exists connections_provider_check;
alter table connections add constraint connections_provider_check
  check (provider in ('google', 'microsoft', 'dropbox', 'box', 'nextcloud', 'local'));

alter table calendar_sync_origins drop constraint if exists calendar_sync_origins_provider_check;
alter table calendar_sync_origins add constraint calendar_sync_origins_provider_check
  check (provider in ('google', 'microsoft', 'local'));

-- One local calendar connection per person, keyed like the Nextcloud one.
create unique index if not exists connections_owner_local
  on connections (owner_user_id, provider)
  where provider = 'local';
