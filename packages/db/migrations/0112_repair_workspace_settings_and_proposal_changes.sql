-- Two writes passed JSON.stringify output to a jsonb parameter, which
-- postgres.js stores as a JSON string scalar. Both now use json(). A migration
-- that fails stops the server starting, so everything here skips what it does
-- not recognise.

-- The member settings policy merged that scalar with settings || $1::jsonb.
-- object || string does not fail: it wraps the object in an array, and every
-- later merge appended to that array, so settings ended up as
--   [{...settings}, "{\"memberSettingsChanges\":\"self\"}", {...a later merge}]
-- The policy then read as 'self' whatever was chosen, and saving a public
-- address failed in jsonb_set. Replay the elements in order, which is what the
-- merges meant to do. Any other array was not made by this write.
do $$
declare
  policy_writes constant jsonb[] := array[
    to_jsonb('{"memberSettingsChanges":"self"}'::text),
    to_jsonb('{"memberSettingsChanges":"super_admin"}'::text)
  ];
  stored jsonb;
  element jsonb;
  repaired jsonb := '{}';
  damaged boolean := false;
begin
  select settings into stored from workspace where id = true;
  if jsonb_typeof(stored) is distinct from 'array' then
    return;
  end if;
  for element in
    select item.value from jsonb_array_elements(stored) with ordinality as item(value, position) order by item.position
  loop
    if element = any(policy_writes) then
      repaired := repaired || (element #>> '{}')::jsonb;
      damaged := true;
    elsif jsonb_typeof(element) = 'object' then
      repaired := repaired || element;
    else
      return;
    end if;
  end loop;
  if damaged then
    update workspace set settings = repaired where id = true;
  end if;
end $$;

-- Deciding a proposal wrote change the same way, so rows decided since 0104 are
-- string scalars again. A row inserted as a string before 0104 and then approved
-- was encoded twice: its text starts with a quote, so 0104 skipped it. Take that
-- extra layer off first, then decode. Objects are untouched.
update improvement_proposals
   set change = (change #>> '{}')::jsonb
 where jsonb_typeof(change) = 'string'
   and (change #>> '{}') ~ '^"\{'
   and pg_input_is_valid(change #>> '{}', 'jsonb');

update improvement_proposals
   set change = (change #>> '{}')::jsonb
 where jsonb_typeof(change) = 'string'
   and (change #>> '{}') ~ '^\s*\{'
   and pg_input_is_valid(change #>> '{}', 'jsonb');
