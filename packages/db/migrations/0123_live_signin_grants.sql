-- Who may sign in for Josi (docs/LIVE_SIGN_IN.md).
--
-- The owner (super admin) always may. Anyone else only when the owner granted
-- it, by asking Josi or on the PC Control page. A grant lets that person see
-- Josi's whole browser, which can include the owner's logins: it is off by
-- default and revoked by deleting the row.
create table live_signin_grants (
  user_id uuid primary key references users(id) on delete cascade,
  granted_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
