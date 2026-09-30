-- Twilio may optionally admit an unlinked sender as a public correspondent.
-- The marker is durable so public traffic never inherits the owner's tools,
-- memory, persona, or pending approvals on a later turn.
alter table external_channel_links
  add column if not exists public_access boolean not null default false;

