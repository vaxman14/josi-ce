-- Windows client as a node: a member may let Josi control the PCs they are
-- signed in on. The owner can switch it off per member; the owner is never gated.
alter table users add column if not exists pc_control_allowed boolean not null default true;
