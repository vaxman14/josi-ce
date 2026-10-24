-- Whether the chat shows what Josi wrote along the way ("Checking your
-- calendar.") above the final answer. Off by default: the final answer alone,
-- as Roman asked on 2026-10-24; the narration stays available as a choice.
alter table persona_settings add column if not exists show_narration boolean not null default false;
