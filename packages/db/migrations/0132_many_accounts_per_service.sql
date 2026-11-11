-- More than one account per developer service, and Stripe.
--
-- A person may have four Supabase accounts, two App Store Connect teams and a
-- client's Netlify. 0033 allowed one row per person per service, on the
-- reasoning that more would be rows nobody could tell apart. They are told
-- apart now: every row has its own short key, the name the service gave it
-- (`account_label`), and an optional name the person gives it (`nickname`).
--
-- `account_key` is 'default' for the first account, which is every row that
-- exists today, so nothing already connected moves. Its sealed credential stays
-- in the Vault slot `token`; another account's is in `token.<account_key>`.

alter table developer_connections
  add column if not exists account_key text not null default 'default'
    check (account_key ~ '^[a-z0-9]{1,24}$'),
  add column if not exists nickname text
    check (nickname is null or length(nickname) between 1 and 60);

alter table developer_connections
  drop constraint if exists developer_connections_owner_user_id_service_key;
create unique index if not exists developer_connections_one_per_account
  on developer_connections (owner_user_id, service, account_key);

-- Stripe joins the services, refused until an administrator permits it, like
-- every service before it.
alter table developer_service_policy
  drop constraint if exists developer_service_policy_service_check;
alter table developer_service_policy
  add constraint developer_service_policy_service_check
  check (service in (
    'github', 'netlify', 'vercel', 'supabase',
    'gitlab', 'cloudflare', 'sentry', 'railway', 'render', 'linear',
    'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
    'appstoreconnect', 'googleplay', 'stripe'
  ));

alter table developer_connections
  drop constraint if exists developer_connections_service_check;
alter table developer_connections
  add constraint developer_connections_service_check
  check (service in (
    'github', 'netlify', 'vercel', 'supabase',
    'gitlab', 'cloudflare', 'sentry', 'railway', 'render', 'linear',
    'dockerhub', 'ghcr', 'jira', 'npm', 'neon', 'notion',
    'appstoreconnect', 'googleplay', 'stripe'
  ));

insert into developer_service_policy (service, mode) values ('stripe', 'not_allowed')
on conflict (service) do nothing;
