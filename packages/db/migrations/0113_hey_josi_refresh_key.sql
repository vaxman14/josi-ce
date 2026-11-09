-- The worker refreshes Google tokens but runs as a different account from the web
-- service, so it can't read the server's key from the OS key store. It uses this
-- one instead: a key hosted accepts for google.refresh and nothing else, sealed
-- with the master key the worker already holds.
alter table hey_josi_link add column refresh_key_enc text;
