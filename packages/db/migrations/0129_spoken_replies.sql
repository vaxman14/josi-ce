-- A message can ask for a reply that will be read aloud (Siri, Shortcuts,
-- CarPlay): one or two plain sentences. The turn remembers it so the worker
-- that runs it later shapes the answer the same way.
alter table assistant_turns add column if not exists reply_style text
  check (reply_style is null or reply_style in ('spoken_short'));
