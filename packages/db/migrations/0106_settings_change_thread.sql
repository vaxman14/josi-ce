-- Which conversation prepared a settings change, so the result of the change
-- (applied, or why not) can be written back into that conversation and Josi
-- stops saying it is still waiting for approval. Additive; nullable because
-- changes prepared outside a conversation have none.
alter table settings_change_proposals
  add column thread_id uuid references threads(id) on delete set null;
