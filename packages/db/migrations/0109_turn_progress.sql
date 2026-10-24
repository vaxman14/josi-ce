-- Live progress of a running turn (build item 16): what Josi is doing right
-- now ("Checking your calendar", "Thinking"), written by the worker as it
-- happens and streamed to the app, so the wait reads as alive and the reply
-- arrives the moment it is saved instead of on the next poll.
alter table assistant_turns add column if not exists progress jsonb;
