-- Desktop-local folders belong to the authenticated desktop session that
-- registered them. They are not account-wide storage: another signed-in
-- computer must not discover or exercise their capabilities.
alter table desktop_workspace_mappings
  add column if not exists session_id uuid references sessions(id) on delete set null;

create index if not exists desktop_workspace_mappings_owner_session
  on desktop_workspace_mappings(owner_user_id, session_id, status, last_seen_at desc);

