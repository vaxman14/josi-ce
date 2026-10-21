-- The Windows app is PC Control's executor. Additive only.
-- Results: what the executor reported for one claimed request, sealed.
create table pc_control_results (
  request_id uuid primary key references pc_control_requests(id) on delete cascade,
  owner_user_id uuid not null,
  pc_id text not null,
  result_enc text not null,
  created_at timestamptz not null default now()
);
-- Presence: the browser currently attached through the Windows app, sealed,
-- with a short expiry the app keeps renewing.
create table pc_control_presence (
  owner_user_id uuid not null,
  pc_id text not null,
  presence_enc text not null,
  expires_at timestamptz not null,
  primary key(owner_user_id, pc_id),
  foreign key(owner_user_id, pc_id) references pc_control_settings on delete cascade
);
