-- Separate one-use delivery/projection claims for the same hardware proof.
-- These are derived receipt state, never another key or policy authority.
alter table protected_control_challenges add column host_delivery_used boolean not null default false;
alter table protected_control_challenges add column host_projection_used boolean not null default false;
alter table protected_control_challenges add column host_state_mac text;
alter table protected_control_challenges add constraint protected_host_state_mac_shape check
  (host_state_mac is null or host_state_mac ~ '^[a-f0-9]{64}$');
-- Pre-migration pending challenges cannot use the new host-proof route.
-- They expire normally; new issuance supplies an authenticated initial state.
