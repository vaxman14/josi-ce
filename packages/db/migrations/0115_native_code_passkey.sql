-- A native sign-in code remembers whether a passkey earned it. A passkey verifies
-- the person, so its code goes straight to a session, as the web sign-in does.
-- Every other code still answers with the authenticator challenge at the exchange.

alter table auth_native_codes
  add column passkey_proved boolean not null default false;
