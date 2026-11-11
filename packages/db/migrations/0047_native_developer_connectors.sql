-- Expand the native developer-service boundary. These rows remain separate
-- from Custom API connections: each service has a fixed identity protocol and
-- its own help/capability contract in packages/connectors.

alter table developer_service_policy
  drop constraint if exists developer_service_policy_service_check;
alter table developer_service_policy
  add constraint developer_service_policy_service_check
  check (service in (
    'github', 'netlify', 'vercel', 'supabase',
    'gitlab', 'cloudflare', 'sentry', 'railway', 'render', 'linear',
    'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
    -- Admitted by 0128. Named here too so re-running this file on a current
    -- database does not narrow the list under rows that already exist.
    'appstoreconnect', 'googleplay'
  ));

alter table developer_connections
  drop constraint if exists developer_connections_service_check;
alter table developer_connections
  add constraint developer_connections_service_check
  check (service in (
    'github', 'netlify', 'vercel', 'supabase',
    'gitlab', 'cloudflare', 'sentry', 'railway', 'render', 'linear',
    'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
    -- Admitted by 0128. Named here too so re-running this file on a current
    -- database does not narrow the list under rows that already exist.
    'appstoreconnect', 'googleplay'
  ));

insert into developer_service_policy (service, mode) values
  ('gitlab', 'not_allowed'),
  ('cloudflare', 'not_allowed'),
  ('sentry', 'not_allowed'),
  ('railway', 'not_allowed'),
  ('render', 'not_allowed'),
  ('linear', 'not_allowed'),
  ('dockerhub', 'not_allowed'),
  ('ghcr', 'not_allowed'),
  ('jira', 'not_allowed'),
  ('npm', 'not_allowed'),
  ('neon', 'not_allowed'),
  ('notion', 'not_allowed')
on conflict (service) do nothing;

alter table developer_connections add column if not exists last_used_at timestamptz;
