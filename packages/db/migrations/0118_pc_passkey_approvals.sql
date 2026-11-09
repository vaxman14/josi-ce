create table pc_passkey_approvals (
  id uuid primary key,
  owner_user_id uuid not null references users(id) on delete cascade,
  proposal_id uuid not null references settings_change_proposals(id) on delete cascade,
  proposal_digest text not null,
  challenge_hash text not null,
  expires_at timestamptz not null,
  used_at timestamptz
);
