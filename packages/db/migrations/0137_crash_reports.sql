-- Crash reports and feedback for beta testers.
--
-- A crash anywhere in Josi (the API, the worker, the browser) is turned into a
-- report with everything private stripped, kept here, and either sent
-- automatically (if the owner switched that on) or shown to the owner on a card
-- to read, edit and send or not. Nothing here holds chat content, Vault data,
-- email addresses, sign-in tokens or home-folder paths: the text is scrubbed
-- before it is stored (packages/core/src/crashReport.ts).
create table if not exists crash_reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  service text not null check (length(service) between 1 and 40),
  kind text not null check (kind in ('crash', 'feedback')),
  -- The report exactly as it would be sent.
  report jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'dismissed', 'failed')),
  attempts integer not null default 0,
  next_try_at timestamptz not null default now(),
  sent_at timestamptz,
  last_error text
);
create index if not exists crash_reports_pending on crash_reports (status, next_try_at);

-- Sends what is waiting every two minutes (only when the owner allows automatic reports).
insert into schedules (kind, payload, interval_seconds, next_run_at, enabled)
select 'crash.flush', '{}'::jsonb, 120, now() + make_interval(secs => 120), true
where not exists (select 1 from schedules where kind = 'crash.flush');
