-- Full control on the local PC: a standing grant for everyday browser, folder
-- and application actions, so the owner is not asked before each one.
-- Money, deleting, credentials, installs, security settings and elevation
-- still ask. Additive only; off by default; the emergency stop clears it.
alter table pc_control_settings add column full_control boolean not null default false;
