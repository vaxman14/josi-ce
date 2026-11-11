-- Two-way reminder sync with a phone's own reminder list (Apple Reminders).
--
-- Two things were missing. A reminder could be delivered, cancelled or failed,
-- but never DONE: nothing recorded that the person ticked it off, so a mirror
-- on the phone had no truthful state to copy. And a reminder had no name in
-- any other system, so a phone pushing the same item twice made two rows.

-- "completed" means the owner marked it done. It is terminal: delivery only
-- ever claims a row whose state is "scheduled", so a completed reminder can
-- not fire or push afterwards.
alter table reminders
  add column completed_at timestamptz,
  -- status gains a fifth value
  drop constraint reminders_status_check,
  add constraint reminders_status_check
    check (status in ('scheduled', 'delivered', 'cancelled', 'failed', 'completed'));

-- Where the reminder came from and what that system calls it. `external_id` is
-- opaque to Josi: stored, compared, returned, never interpreted. `notes` is the
-- phone's free-text detail; the reminder still fires with `body` alone.
alter table reminders
  add column source text not null default 'josi' check (source in ('josi', 'ios')),
  add column external_id text check (external_id is null or char_length(external_id) between 1 and 200),
  add column notes text check (notes is null or char_length(notes) <= 4000),
  add constraint reminders_external_needs_source check (external_id is null or source <> 'josi');

-- One row per (owner, source, external id). The owner is part of the key, so
-- two people whose phones happen to issue the same identifier never collide,
-- and nobody can reach another member's reminder by guessing its external id.
create unique index reminders_external_identity
  on reminders (owner_user_id, source, external_id)
  where external_id is not null;
