-- Josi's own email (sign-in codes, password resets, notices to the owner) can
-- go out through a Google or Microsoft account the owner connected, instead of
-- an SMTP server. One row at most: when it is here and its connection is
-- active, that account sends; otherwise the SMTP system profile does.
create table if not exists system_mail_account (
  id boolean primary key default true check (id),
  connection_id uuid not null references connections(id) on delete cascade,
  provider text not null check (provider in ('google', 'microsoft')),
  from_name text not null default 'Josi',
  configured_by uuid references users(id) on delete set null,
  updated_at timestamptz not null default now()
);
alter table system_mail_account enable row level security;

-- Sign in with Microsoft shares the browser sign-in states with Google. A
-- state is redeemed only by the provider it was started for.
alter table auth_oauth_states add column if not exists provider text not null default 'google';
