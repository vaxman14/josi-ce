-- Provider receipt/projection only. Goal content remains in work_goals;
-- bot credentials remain in the Vault. An uncertain first send is never
-- retried automatically because Telegram has no send idempotency key.
create table telegram_work_progress (
  goal_id uuid primary key references work_goals(id) on delete cascade,
  owner_user_id uuid not null references users(id) on delete cascade,
  link_id uuid not null references telegram_links(id) on delete cascade,
  bot_id text not null,
  chat_id bigint not null,
  message_id bigint,
  last_sent_revision integer not null default 0,
  content_digest text,
  state text not null default 'ready' check(state in ('ready','sending','sent','uncertain','failed','disabled')),
  attempt_id uuid,
  started_at timestamptz,
  next_attempt_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  error_code text,
  check(message_id is null or message_id > 0)
);
alter table telegram_work_progress enable row level security;
insert into schedules(kind,payload,interval_seconds,next_run_at,enabled)
select 'work-progress.telegram','{}'::jsonb,10,now()+interval '10 seconds',true
where not exists(select 1 from schedules where kind='work-progress.telegram');
