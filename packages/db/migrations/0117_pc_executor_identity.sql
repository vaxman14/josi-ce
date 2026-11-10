create table pc_executor_identity (
  owner_user_id uuid not null references users(id) on delete cascade,
  pc_id text not null,
  public_key text not null,
  enrolled_at timestamptz not null default now(),
  primary key(owner_user_id,pc_id)
);
create table pc_executor_nonce (
  owner_user_id uuid not null references users(id) on delete cascade,
  pc_id text not null,
  nonce uuid not null,
  expires_at timestamptz not null,
  primary key(owner_user_id,pc_id,nonce)
);
