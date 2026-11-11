-- App Store Connect and Google Play join the developer services.
--
-- Their credential is a signing key in several parts (Issuer ID, Key ID and a
-- .p8 file; a service account JSON and a package name) rather than one token.
-- That changes nothing about where it lives: every part is sealed together as
-- one Vault payload behind the same `credentials_enc` reference the token
-- services use. There is deliberately no new column here — a plain column for
-- any part of a key would be a second place a secret could be read from.
--
-- So the only schema change is admitting the two service names, and, like every
-- service before them, they start refused until an administrator permits them.

alter table developer_service_policy
  drop constraint if exists developer_service_policy_service_check;
alter table developer_service_policy
  add constraint developer_service_policy_service_check
  check (service in (
    'github', 'netlify', 'vercel', 'supabase',
    'gitlab', 'cloudflare', 'sentry', 'railway', 'render', 'linear',
    'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
    'appstoreconnect', 'googleplay',
    -- Admitted by 0132; named here so re-running this file does not narrow the list.
    'stripe'
  ));

alter table developer_connections
  drop constraint if exists developer_connections_service_check;
alter table developer_connections
  add constraint developer_connections_service_check
  check (service in (
    'github', 'netlify', 'vercel', 'supabase',
    'gitlab', 'cloudflare', 'sentry', 'railway', 'render', 'linear',
    'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
    'appstoreconnect', 'googleplay',
    -- Admitted by 0132; named here so re-running this file does not narrow the list.
    'stripe'
  ));

insert into developer_service_policy (service, mode) values
  ('appstoreconnect', 'not_allowed'),
  ('googleplay', 'not_allowed')
on conflict (service) do nothing;
